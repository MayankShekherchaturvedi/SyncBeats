import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  StatusBar,
  ScrollView,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import io from 'socket.io-client';

const DEFAULT_SERVER_URL = 'http://192.168.1.13:5000';
const CACHED_TRACK_PATH = FileSystem.cacheDirectory + 'syncbeats_current_track.mp3';

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);

  // Song library state
  const [songs, setSongs] = useState([]);
  const [selectedSongId, setSelectedSongId] = useState(null);
  const [currentSong, setCurrentSong] = useState(null);

  // Download/caching state
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Room/session state
  const [roomCode, setRoomCode] = useState('');
  const [joined, setJoined] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hostLeft, setHostLeft] = useState(false);
  const [showSongPicker, setShowSongPicker] = useState(false);
  const [showCreateFlow, setShowCreateFlow] = useState(false);

  // Status & error
  const [statusText, setStatusText] = useState('Connecting...');
  const [errorMessage, setErrorMessage] = useState('');

  const socketRef = useRef(null);
  const playerRef = useRef(null);
  const statusSubscriptionRef = useRef(null);
  const isRemoteEvent = useRef(false);
  const pendingSync = useRef(null);
  const downloadResumableRef = useRef(null);

  // ─── Fetch song catalog ────────────────────────────────────────────────────
  const fetchSongs = useCallback(async (url) => {
    try {
      const res = await fetch(`${url || serverUrl}/api/songs`);
      const data = await res.json();
      if (data.success && Array.isArray(data.songs)) {
        setSongs(data.songs);
        if (data.songs.length > 0) {
          setSelectedSongId((prev) => prev || data.songs[0].id);
        }
      }
    } catch {
      // Backend not reachable yet
    }
  }, [serverUrl]);

  // ─── Download track into device temp cache ────────────────────────────────
  const downloadAndLoadAudio = useCallback(async (song) => {
    if (!song || !song.fileUrl) return;

    try {
      setIsDownloading(true);
      setDownloadProgress(0);
      setCurrentSong(song);

      // Clean up previous player & subscription
      if (statusSubscriptionRef.current) {
        statusSubscriptionRef.current.remove();
        statusSubscriptionRef.current = null;
      }
      if (playerRef.current) {
        playerRef.current.pause();
        playerRef.current.release();
        playerRef.current = null;
      }

      // Delete old cache file if present
      const existing = await FileSystem.getInfoAsync(CACHED_TRACK_PATH);
      if (existing.exists) {
        await FileSystem.deleteAsync(CACHED_TRACK_PATH, { idempotent: true });
      }

      // Download with progress callback
      const downloadResumable = FileSystem.createDownloadResumable(
        song.fileUrl,
        CACHED_TRACK_PATH,
        {},
        (progress) => {
          if (progress.totalBytesExpectedToWrite > 0) {
            const pct = Math.round(
              (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * 100
            );
            setDownloadProgress(pct);
          }
        }
      );
      downloadResumableRef.current = downloadResumable;

      const result = await downloadResumable.downloadAsync();
      if (!result || !result.uri) throw new Error('Download failed');

      setDownloadProgress(100);

      // Configure audio mode for background / silent switch playback
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
      }).catch(() => {});

      // Create new modern AudioPlayer from cached local URI
      const player = createAudioPlayer(result.uri);
      playerRef.current = player;

      const sub = player.addListener('playbackStatusUpdate', (status) => {
        setIsPlaying(status.playing);
      });
      statusSubscriptionRef.current = sub;

      // Apply any sync action that arrived while downloading
      if (pendingSync.current) {
        const { action, currentTime } = pendingSync.current;
        pendingSync.current = null;
        await player.seekTo(currentTime);
        if (action === 'play') {
          player.play();
        }
      }

      setIsDownloading(false);
    } catch (err) {
      console.log('Download/load error, falling back to direct stream:', err);
      // Fallback: stream directly from backend without caching
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: true,
        }).catch(() => {});

        const player = createAudioPlayer(song.fileUrl);
        playerRef.current = player;
        const sub = player.addListener('playbackStatusUpdate', (status) => {
          setIsPlaying(status.playing);
        });
        statusSubscriptionRef.current = sub;
      } catch (streamErr) {
        console.log('Stream fallback also failed:', streamErr);
      }
      setIsDownloading(false);
    }
  }, []);

  // ─── Socket setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetchSongs(serverUrl);

    const socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setStatusText('Connected to Server');
      setErrorMessage('');
      fetchSongs(serverUrl);
    });

    socket.on('disconnect', () => setStatusText('Disconnected'));

    socket.on('connect_error', () => {
      setStatusText('Connection error');
      setErrorMessage(`Cannot connect to backend at ${serverUrl}`);
    });

    socket.on('songs-updated', () => {
      fetchSongs(serverUrl);
    });

    socket.on('room-role', ({ isHost: assignedHost }) => {
      setIsHost(assignedHost);
      setHostLeft(false);
      setErrorMessage('');
    });

    // Backend sends the current room song on join
    socket.on('room-song', (song) => {
      downloadAndLoadAudio(song);
    });

    // Host changed the song mid-session
    socket.on('song-changed', ({ song, currentTime }) => {
      if (playerRef.current) {
        playerRef.current.pause();
      }
      setShowSongPicker(false);
      pendingSync.current = { action: 'pause', currentTime: currentTime || 0 };
      downloadAndLoadAudio(song);
    });

    socket.on('sync-action', async ({ action, currentTime }) => {
      if (!playerRef.current) {
        pendingSync.current = { action, currentTime };
        return;
      }
      isRemoteEvent.current = true;
      try {
        await playerRef.current.seekTo(currentTime);
        if (action === 'play') {
          playerRef.current.play();
        } else if (action === 'pause') {
          playerRef.current.pause();
        }
      } catch (err) {
        console.log('sync-action error:', err);
      }
      setTimeout(() => {
        isRemoteEvent.current = false;
      }, 300);
    });

    socket.on('sync-state', async ({ action, currentTime }) => {
      if (!playerRef.current) {
        pendingSync.current = { action, currentTime };
        return;
      }
      try {
        await playerRef.current.seekTo(currentTime);
        if (action === 'play') playerRef.current.play();
      } catch (err) {
        console.log('sync-state error:', err);
      }
    });

    socket.on('host-left', () => {
      playerRef.current?.pause();
      setIsPlaying(false);
      setIsHost(false);
      setHostLeft(true);
    });

    socket.on('room-error', ({ message }) => setErrorMessage(message));
    socket.on('control-denied', ({ message }) => setErrorMessage(message));

    return () => {
      if (statusSubscriptionRef.current) {
        statusSubscriptionRef.current.remove();
        statusSubscriptionRef.current = null;
      }
      if (playerRef.current) {
        playerRef.current.pause();
        playerRef.current.release();
        playerRef.current = null;
      }
      socket.disconnect();
      // Clean up cached file on unmount
      FileSystem.deleteAsync(CACHED_TRACK_PATH, { idempotent: true }).catch(() => {});
    };
  }, [serverUrl, fetchSongs, downloadAndLoadAudio]);

  // ─── Host creates room with selected song ─────────────────────────────────
  const handleCreateRoom = async () => {
    try {
      setErrorMessage('');
      const res = await fetch(`${serverUrl}/api/create-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songId: selectedSongId }),
      });
      const data = await res.json();
      if (data.success && data.room) {
        const newCode = data.room.code;
        setRoomCode(newCode);
        setIsHost(true);
        setHostLeft(false);
        setShowCreateFlow(false);
        if (data.room.currentSong) {
          downloadAndLoadAudio(data.room.currentSong);
        }
        socketRef.current?.emit('join-room', { roomCode: newCode });
        setJoined(true);
      } else {
        setErrorMessage(data.error || 'Failed to create room.');
      }
    } catch {
      setErrorMessage('Cannot reach backend server to create room.');
    }
  };

  // ─── Join existing room ────────────────────────────────────────────────────
  const handleJoin = () => {
    const cleanCode = roomCode.trim().toUpperCase();
    if (!cleanCode) {
      setErrorMessage('Please enter a room code.');
      return;
    }
    setErrorMessage('');
    setIsHost(false);
    setHostLeft(false);
    socketRef.current?.emit('join-room', { roomCode: cleanCode });
    setJoined(true);
  };

  // ─── Leave room & clean temp cache ────────────────────────────────────────
  const handleLeave = async () => {
    if (statusSubscriptionRef.current) {
      statusSubscriptionRef.current.remove();
      statusSubscriptionRef.current = null;
    }
    if (playerRef.current) {
      playerRef.current.pause();
      playerRef.current.release();
      playerRef.current = null;
    }
    socketRef.current?.emit('leave-room', { roomCode: roomCode.trim().toUpperCase() });
    await FileSystem.deleteAsync(CACHED_TRACK_PATH, { idempotent: true }).catch(() => {});
    setCurrentSong(null);
    setJoined(false);
    setIsHost(false);
    setHostLeft(false);
    setIsPlaying(false);
    setShowSongPicker(false);
    setErrorMessage('');
  };

  // ─── Host changes song mid-session ────────────────────────────────────────
  const handleChangeSong = (songId) => {
    if (!isHost) return;
    socketRef.current?.emit('change-song', {
      roomCode: roomCode.trim().toUpperCase(),
      songId,
    });
    setShowSongPicker(false);
  };

  // ─── Host play/pause ───────────────────────────────────────────────────────
  const togglePlayPause = async () => {
    if (!isHost || !playerRef.current || isRemoteEvent.current || isDownloading) return;
    const currentTime = playerRef.current.currentTime || 0;
    const cleanCode = roomCode.trim().toUpperCase();

    if (isPlaying) {
      playerRef.current.pause();
      socketRef.current?.emit('audio-action', { roomCode: cleanCode, action: 'pause', currentTime });
    } else {
      playerRef.current.play();
      socketRef.current?.emit('audio-action', { roomCode: cleanCode, action: 'play', currentTime });
    }
  };

  const formatDuration = (seconds) => {
    if (!seconds) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const isConnected = statusText.startsWith('Connected');

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>🎵 Syncbeats</Text>
          <View style={[styles.statusBadge, { borderColor: isConnected ? '#1db954' : '#ff6b6b' }]}>
            <Text style={[styles.statusText, { color: isConnected ? '#1db954' : '#ff6b6b' }]}>
              {statusText}
            </Text>
          </View>
        </View>

        {/* Error Banner */}
        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* ── LOBBY ── */}
        {!joined ? (
          <View style={{ width: '100%', maxWidth: 400 }}>

            {/* Backend URL input */}
            <View style={styles.card}>
              <Text style={styles.label}>Backend Server URL</Text>
              <TextInput
                style={styles.input}
                placeholder="http://192.168.1.13:5000"
                placeholderTextColor="#555"
                value={serverUrl}
                onChangeText={setServerUrl}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {/* Create Room section */}
            {!showCreateFlow ? (
              <TouchableOpacity
                style={[styles.button, styles.buttonGreen]}
                onPress={() => setShowCreateFlow(true)}
              >
                <Text style={styles.buttonText}>🚀 Create Room & Host</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Select a Song to Host</Text>
                <Text style={styles.hint}>Followers who join will auto-download and sync this track.</Text>

                <FlatList
                  data={songs}
                  keyExtractor={(item) => item.id}
                  scrollEnabled={false}
                  ListEmptyComponent={
                    <Text style={{ color: '#555', fontSize: 13, padding: 10 }}>
                      No songs found. Is the backend running?
                    </Text>
                  }
                  renderItem={({ item }) => {
                    const sel = item.id === selectedSongId;
                    return (
                      <TouchableOpacity
                        style={[styles.songRow, sel && styles.songRowSelected]}
                        onPress={() => setSelectedSongId(item.id)}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.songTitle, sel && { color: '#1db954', fontWeight: 'bold' }]}>
                            {item.title}
                          </Text>
                          <Text style={styles.songArtist}>{item.artist}</Text>
                        </View>
                        <Text style={styles.songDuration}>{formatDuration(item.duration)}</Text>
                      </TouchableOpacity>
                    );
                  }}
                />

                <TouchableOpacity
                  style={[styles.button, styles.buttonGreen, { marginTop: 12 }]}
                  onPress={handleCreateRoom}
                  disabled={songs.length === 0}
                >
                  <Text style={styles.buttonText}>Start Room with Selected Track</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.button, styles.buttonDark, { marginTop: 8 }]}
                  onPress={() => setShowCreateFlow(false)}
                >
                  <Text style={[styles.buttonText, { color: '#888' }]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Divider */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Join Room section */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Join an Existing Room</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter Room Code (e.g. AB1C2)"
                placeholderTextColor="#555"
                value={roomCode}
                onChangeText={setRoomCode}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={[styles.button, styles.buttonDark, { marginTop: 4 }]}
                onPress={handleJoin}
              >
                <Text style={styles.buttonText}>Join Room</Text>
              </TouchableOpacity>
            </View>

          </View>
        ) : (
          /* ── IN-ROOM VIEW ── */
          <View style={{ width: '100%', maxWidth: 400 }}>
            <View style={styles.card}>

              {/* Room Header Row */}
              <View style={styles.headerRow}>
                <View>
                  <Text style={styles.roomLabel}>ROOM CODE</Text>
                  <Text style={styles.roomCode}>{roomCode.toUpperCase()}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {isHost && (
                    <TouchableOpacity
                      style={styles.iconButton}
                      onPress={() => setShowSongPicker(!showSongPicker)}
                    >
                      <Text style={{ color: '#fff', fontSize: 12 }}>🎶 Songs</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={styles.leaveButton} onPress={handleLeave}>
                    <Text style={styles.leaveButtonText}>Leave</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Host Song Switcher */}
              {isHost && showSongPicker && (
                <View style={styles.songPickerPanel}>
                  <Text style={styles.sectionTitle}>Change Room Song</Text>
                  {songs.map((song) => (
                    <TouchableOpacity
                      key={song.id}
                      style={[
                        styles.songRow,
                        currentSong?.id === song.id && styles.songRowSelected,
                        { marginBottom: 6 },
                      ]}
                      onPress={() => handleChangeSong(song.id)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.songTitle, currentSong?.id === song.id && { color: '#1db954' }]}>
                          {song.title}
                        </Text>
                        <Text style={styles.songArtist}>{song.artist}</Text>
                      </View>
                      <Text style={styles.songDuration}>{formatDuration(song.duration)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* Current Song Info */}
              <View style={styles.nowPlayingCard}>
                <Text style={styles.nowPlayingEmoji}>🎵</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.nowPlayingTitle}>
                    {currentSong ? currentSong.title : 'Waiting for song...'}
                  </Text>
                  <Text style={styles.nowPlayingArtist}>
                    {currentSong
                      ? `${currentSong.artist} · ${formatDuration(currentSong.duration)}`
                      : 'Loading...'}
                  </Text>
                </View>
              </View>

              {/* Download Progress Bar */}
              {isDownloading && (
                <View style={styles.progressContainer}>
                  <View style={styles.progressLabelRow}>
                    <Text style={styles.progressLabel}>⏳ Downloading for zero-lag sync...</Text>
                    <Text style={styles.progressLabel}>{downloadProgress}%</Text>
                  </View>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${downloadProgress}%` }]} />
                  </View>
                </View>
              )}

              {/* Role Label */}
              <Text style={[styles.roleText, isHost ? styles.roleHost : styles.roleFollower]}>
                {isHost
                  ? '★ You are the host. Your controls sync all listeners.'
                  : hostLeft
                  ? '⚠️ The host left. Session has ended.'
                  : '👥 Following the host in real time.'}
              </Text>

              {/* Controls */}
              {isHost && !isDownloading ? (
                <TouchableOpacity style={styles.playButton} onPress={togglePlayPause}>
                  <Text style={styles.playButtonText}>{isPlaying ? '⏸ PAUSE' : '▶ PLAY'}</Text>
                </TouchableOpacity>
              ) : !isHost ? (
                <View style={styles.followerInfo}>
                  <Text style={styles.followerInfoText}>
                    {isDownloading
                      ? 'Downloading track to your device…'
                      : hostLeft
                      ? 'Session ended. Tap Leave to exit.'
                      : 'Track downloaded to temp cache. Listening in sync! 🎧'}
                  </Text>
                </View>
              ) : null}

            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212' },
  scrollContent: {
    padding: 20,
    alignItems: 'center',
    paddingBottom: 40,
  },
  header: {
    width: '100%',
    maxWidth: 400,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: '#1a1a1a',
  },
  statusText: { fontSize: 11, fontWeight: '600' },
  errorBanner: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#ff444420',
    borderWidth: 1,
    borderColor: '#ff4444',
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  errorText: { color: '#ff6b6b', fontSize: 13, textAlign: 'center' },
  card: {
    width: '100%',
    backgroundColor: '#1e1e1e',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 6,
  },
  hint: { fontSize: 12, color: '#777', marginBottom: 12 },
  label: { fontSize: 12, color: '#aaa', marginBottom: 6 },
  input: {
    width: '100%',
    height: 46,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#fff',
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 12,
  },
  button: {
    width: '100%',
    height: 46,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGreen: { backgroundColor: '#1db954' },
  buttonDark: { backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#333' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 14,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#2a2a2a' },
  dividerText: { color: '#555', marginHorizontal: 12, fontSize: 12 },
  songRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    backgroundColor: '#252525',
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  songRowSelected: {
    borderColor: '#1db954',
    backgroundColor: '#1db95415',
  },
  songTitle: { color: '#fff', fontSize: 14, fontWeight: '500' },
  songArtist: { color: '#777', fontSize: 12, marginTop: 2 },
  songDuration: { color: '#777', fontSize: 12 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  roomLabel: { fontSize: 11, color: '#777', textTransform: 'uppercase' },
  roomCode: { fontSize: 24, fontWeight: 'bold', color: '#1db954', letterSpacing: 2 },
  iconButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#2a2a2a',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#444',
  },
  leaveButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#ff444420',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#ff4444',
  },
  leaveButtonText: { color: '#ff6b6b', fontSize: 12, fontWeight: '600' },
  songPickerPanel: {
    backgroundColor: '#252525',
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#333',
  },
  nowPlayingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#252525',
    padding: 12,
    borderRadius: 8,
    marginBottom: 14,
    gap: 12,
  },
  nowPlayingEmoji: { fontSize: 28 },
  nowPlayingTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  nowPlayingArtist: { color: '#aaa', fontSize: 13, marginTop: 2 },
  progressContainer: { marginBottom: 14 },
  progressLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  progressLabel: { color: '#aaa', fontSize: 12 },
  progressTrack: {
    width: '100%',
    height: 6,
    backgroundColor: '#333',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#1db954' },
  roleText: { fontSize: 13, textAlign: 'center', marginBottom: 14 },
  roleHost: { color: '#1db954' },
  roleFollower: { color: '#aaa' },
  playButton: {
    width: '100%',
    height: 50,
    backgroundColor: '#1db954',
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold', letterSpacing: 1 },
  followerInfo: {
    backgroundColor: '#252525',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  followerInfoText: { color: '#aaa', fontSize: 13, textAlign: 'center' },
});
