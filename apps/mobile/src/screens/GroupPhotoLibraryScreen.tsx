import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { apiClient } from '../services/apiClient';
import { useAuthStore } from '../stores/authStore';
import { useSocketStore } from '../stores/socketStore';
import { pickAndUploadPhoto } from '../services/PhotoUploadService';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import { SkeletonBox } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { useTheme, ThemeColors } from '../theme';

const SCREEN_WIDTH = Dimensions.get('window').width;
const CELL_SIZE = (SCREEN_WIDTH - 3) / 2;

interface Photo {
  id: string;
  userId: string;
  displayName: string;
  photoUrl: string;
  caption: string | null;
  createdAt: string;
}

// Long-press a photo you own to reveal a delete overlay — mirrors the
// long-press-to-delete pattern used for fuel log entries (FuelLogScreen).
// The API only allows a user to delete their own photos (photos.routes.ts
// DELETE /groups/:groupId/photos/:photoId scopes on user_id), so the option
// is only surfaced for photos the current user posted.
function PhotoCell({ photo, canDelete, deleting, onDelete, onView }: {
  photo: Photo; canDelete: boolean; deleting: boolean; onDelete: (id: string) => void; onView: (photo: Photo) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [open, setOpen] = useState(false);

  return (
    <Pressable
      onPress={() => { if (!open && !deleting) onView(photo); }}
      onLongPress={() => { if (canDelete && !deleting) setOpen((prev) => !prev); }}
      style={styles.cell}
      accessibilityRole="button"
      accessibilityLabel={`Photo by ${photo.displayName}`}
    >
      <Image source={{ uri: photo.photoUrl }} style={styles.cellImage} resizeMode="cover" />
      <View style={styles.cellOverlay}>
        <Text style={styles.cellName} numberOfLines={1}>{photo.displayName}</Text>
        {photo.caption ? (
          <Text style={styles.cellCaption} numberOfLines={2}>{photo.caption}</Text>
        ) : null}
      </View>
      {open && (
        <View style={styles.cellDeleteOverlay}>
          {deleting ? (
            <View style={styles.cellDeletingWrap}>
              <ActivityIndicator size="small" color={colors.accent} />
            </View>
          ) : (
            <>
              <TouchableOpacity
                style={styles.cellDeleteBtn}
                onPress={() => onDelete(photo.id)}
                accessibilityRole="button"
                accessibilityLabel="Delete photo"
              >
                <Ionicons name="trash-outline" size={14} color={colors.accent} />
                <Text style={styles.cellDeleteText}> Delete</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cellCancelBtn}
                onPress={() => setOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.cellCancelText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}
    </Pressable>
  );
}

// Fullscreen lightbox — tap the cell to open, tap the backdrop (or the ✕) to
// dismiss. Kept intentionally simple (plain Modal, no pinch-zoom) to match the
// rest of this screen's minimal styling.
function PhotoViewerModal({ photo, onClose }: { photo: Photo | null; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Modal visible={photo !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.viewerBackdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close photo">
        {photo && (
          <SafeAreaView style={styles.viewerSafeArea}>
            <TouchableOpacity
              style={styles.viewerCloseBtn}
              onPress={onClose}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={20} color="#FFFFFF" />
            </TouchableOpacity>

            {/* Stop propagation so tapping the image itself doesn't dismiss */}
            <Pressable style={styles.viewerImageWrap} onPress={(e) => e.stopPropagation()}>
              <Image source={{ uri: photo.photoUrl }} style={styles.viewerImage} resizeMode="contain" />
            </Pressable>

            <View style={styles.viewerCaptionBox}>
              <Text style={styles.viewerName}>{photo.displayName}</Text>
              {photo.caption ? <Text style={styles.viewerCaption}>{photo.caption}</Text> : null}
            </View>
          </SafeAreaView>
        )}
      </Pressable>
    </Modal>
  );
}

export default function GroupPhotoLibraryScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { accessToken, user } = useAuthStore();
  const { socket } = useSocketStore();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [viewerPhoto, setViewerPhoto] = useState<Photo | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? '';

  const load = useCallback(async () => {
    if (!groupId) return;
    setError(null);
    try {
      const res = await apiClient.get<{ photos: Photo[] }>(`/api/v1/groups/${groupId}/photos`);
      setPhotos(res.data.photos);
    } catch { setError('Could not load photos.'); } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void load(); }, [load]);

  // Live updates: the API broadcasts `group:photo_added` to the group's socket
  // room (see apps/api/src/groups/photos.routes.ts) whenever anyone uploads a
  // photo. The socket is already joined to this group's room on connection
  // (apps/api/src/socket/socket.handler.ts), so no explicit room-join call is
  // needed here — same pattern GroupChatScreen uses for `group:message`.
  useEffect(() => {
    if (!socket || !groupId) return;

    const handlePhotoAdded = (photo: Photo) => {
      setPhotos((prev) => (prev.some((p) => p.id === photo.id) ? prev : [photo, ...prev]));
    };

    socket.on('group:photo_added', handlePhotoAdded);
    return () => { socket.off('group:photo_added', handlePhotoAdded); };
  }, [socket, groupId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const handleUpload = useCallback(async () => {
    if (!groupId || !accessToken || uploadingPhoto) return;
    setUploadingPhoto(true);
    try {
      const result = await pickAndUploadPhoto(groupId, accessToken, apiUrl);
      if (result) {
        await load();
      }
    } catch {
      Alert.alert('Upload Failed', 'Something went wrong. Please try again.');
    } finally {
      setUploadingPhoto(false);
    }
  }, [groupId, accessToken, apiUrl, uploadingPhoto, load]);

  const handleDelete = useCallback((photoId: string) => {
    if (!groupId) return;
    Alert.alert('Delete Photo', 'Remove this photo from the group library? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          setDeletingId(photoId);
          try {
            await apiClient.delete(`/api/v1/groups/${groupId}/photos/${photoId}`);
            setPhotos((prev) => prev.filter((p) => p.id !== photoId));
          } catch {
            Alert.alert('Error', 'Could not delete photo. Please try again.');
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  }, [groupId]);

  // Req 33 — cap the grid to 4 tiles while the vehicle is in motion (see
  // MotionAwareList): at 2 columns that's 2 rows, visible without scrolling,
  // with the shared "pull over" notice below the last row.
  const { data: visiblePhotos, hiddenCount } = useMotionCappedData(photos);

  const renderPhotoItem = useCallback(
    ({ item }: { item: Photo }) => (
      <PhotoCell
        photo={item}
        canDelete={item.userId === user?.id}
        deleting={deletingId === item.id}
        onDelete={handleDelete}
        onView={setViewerPhoto}
      />
    ),
    [user?.id, deletingId, handleDelete],
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.back}>
            <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
          </Text>
        </TouchableOpacity>
        <View style={styles.titleRow}>
          <Ionicons name="camera-outline" size={16} color={colors.text} />
          <Text style={styles.title}> Photos</Text>
        </View>
        <TouchableOpacity
          onPress={handleUpload}
          disabled={uploadingPhoto}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Add photo"
          accessibilityState={{ disabled: uploadingPhoto }}
          style={styles.addBtn}
        >
          {uploadingPhoto ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Text style={styles.uploadBtn}>
              <Ionicons name="add" size={16} color={colors.accent} /> Add
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.skeletonGrid}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <SkeletonBox key={i} width={CELL_SIZE} height={CELL_SIZE} borderRadius={0} />
          ))}
        </View>
      ) : error ? (
        <NetworkError onRetry={() => { setLoading(true); void load(); }} message={error} />
      ) : photos.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="camera-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>No Photos Yet</Text>
          <Text style={styles.emptySubtitle}>Share your drive photos here!</Text>
        </View>
      ) : (
        <FlatList
          data={visiblePhotos}
          keyExtractor={(p) => p.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          renderItem={renderPhotoItem}
          ListFooterComponent={<MotionCapNotice hiddenCount={hiddenCount} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
          }
          contentContainerStyle={styles.list}
        />
      )}

      <PhotoViewerModal photo={viewerPhoto} onClose={() => setViewerPhoto(null)} />
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backBtn: { minWidth: 60, minHeight: 44, justifyContent: 'center' },
    back: { fontSize: 17, color: colors.accent, fontWeight: '600' },
    addBtn: { minWidth: 60, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
    titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
    title: { fontSize: 17, fontWeight: '700', color: colors.text },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
    emptySubtitle: { fontSize: 14, color: colors.textMuted },
    skeletonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 1, padding: 1 },
    list: { padding: 1 },
    row: { gap: 1 },
    cell: { width: CELL_SIZE, height: CELL_SIZE, backgroundColor: colors.card, marginBottom: 1 },
    cellImage: { width: '100%', height: '100%' },
    cellOverlay: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      padding: 8,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    cellName: { fontSize: 11, fontWeight: '600', color: '#FFFFFF' },
    cellCaption: { fontSize: 10, color: '#CCCCCC', marginTop: 2 },
    uploadBtn: { fontSize: 15, color: colors.accent, fontWeight: '700' },
    cellDeleteOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      flexDirection: 'row',
    },
    cellDeleteBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      borderRightWidth: 1,
      borderRightColor: 'rgba(255,255,255,0.15)',
    },
    cellDeleteText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
    cellCancelBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    cellCancelText: { color: '#CCCCCC', fontSize: 13 },
    cellDeletingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },

    viewerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)' },
    viewerSafeArea: { flex: 1 },
    viewerCloseBtn: {
      position: 'absolute', top: 12, right: 16, zIndex: 10,
      width: 36, height: 36, borderRadius: 18,
      backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center',
    },
    viewerImageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    viewerImage: { width: SCREEN_WIDTH, height: '80%' },
    viewerCaptionBox: { paddingHorizontal: 20, paddingBottom: 32, paddingTop: 8 },
    viewerName: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
    viewerCaption: { color: '#CCCCCC', fontSize: 13, marginTop: 4 },
  });
}
