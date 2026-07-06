import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { useAuthStore } from '../stores/authStore';
import { pickAndUploadPhoto } from '../services/PhotoUploadService';
import { SkeletonBox } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';

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
function PhotoCell({ photo, canDelete, onDelete }: {
  photo: Photo; canDelete: boolean; onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Pressable
      onLongPress={() => { if (canDelete) setOpen((prev) => !prev); }}
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
          <TouchableOpacity
            style={styles.cellDeleteBtn}
            onPress={() => { setOpen(false); onDelete(photo.id); }}
            accessibilityRole="button"
            accessibilityLabel="Delete photo"
          >
            <Text style={styles.cellDeleteText}>🗑 Delete</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cellCancelBtn}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.cellCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
    </Pressable>
  );
}

export default function GroupPhotoLibraryScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { accessToken, user } = useAuthStore();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

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
    Alert.alert('Delete Photo', 'Remove this photo from the group library?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await apiClient.delete(`/api/v1/groups/${groupId}/photos/${photoId}`);
            setPhotos((prev) => prev.filter((p) => p.id !== photoId));
          } catch {
            Alert.alert('Error', 'Could not delete photo.');
          }
        },
      },
    ]);
  }, [groupId]);

  const renderPhotoItem = useCallback(
    ({ item }: { item: Photo }) => (
      <PhotoCell photo={item} canDelete={item.userId === user?.id} onDelete={handleDelete} />
    ),
    [user?.id, handleDelete],
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>📷 Photos</Text>
        <TouchableOpacity
          onPress={handleUpload}
          disabled={uploadingPhoto}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Add photo"
          style={{ width: 60, alignItems: 'flex-end' }}
        >
          {uploadingPhoto ? (
            <ActivityIndicator size="small" color="#DC143C" />
          ) : (
            <Text style={styles.uploadBtn}>+ Add</Text>
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
          <Text style={styles.emptyIcon}>📷</Text>
          <Text style={styles.emptyTitle}>No Photos Yet</Text>
          <Text style={styles.emptySubtitle}>Share your drive photos here!</Text>
        </View>
      ) : (
        <FlatList
          data={photos}
          keyExtractor={(p) => p.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          renderItem={renderPhotoItem}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#DC143C" colors={['#DC143C']} />
          }
          contentContainerStyle={styles.list}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1C1C1C',
  },
  back: { fontSize: 17, color: '#DC143C', fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  emptySubtitle: { fontSize: 14, color: '#888888' },
  skeletonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 1, padding: 1 },
  list: { padding: 1 },
  row: { gap: 1 },
  cell: { width: CELL_SIZE, height: CELL_SIZE, backgroundColor: '#1C1C1C', marginBottom: 1 },
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
  uploadBtn: { fontSize: 15, color: '#DC143C', fontWeight: '700' },
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
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.15)',
  },
  cellDeleteText: { color: '#DC143C', fontSize: 13, fontWeight: '600' },
  cellCancelBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cellCancelText: { color: '#CCCCCC', fontSize: 13 },
});
