import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { apiClient } from '../services/apiClient';

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

function PhotoCell({ photo }: { photo: Photo }) {
  return (
    <View style={styles.cell}>
      <Image source={{ uri: photo.photoUrl }} style={styles.cellImage} resizeMode="cover" />
      <View style={styles.cellOverlay}>
        <Text style={styles.cellName} numberOfLines={1}>{photo.displayName}</Text>
        {photo.caption ? (
          <Text style={styles.cellCaption} numberOfLines={2}>{photo.caption}</Text>
        ) : null}
      </View>
    </View>
  );
}

export default function GroupPhotoLibraryScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!groupId) return;
    try {
      const res = await apiClient.get<{ photos: Photo[] }>(`/api/v1/groups/${groupId}/photos`);
      setPhotos(res.data.photos);
    } catch { /* keep existing */ } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>📷 Photos</Text>
        <View style={{ width: 60 }} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color="#DC143C" size="large" />
        </View>
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
          renderItem={({ item }) => <PhotoCell photo={item} />}
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
});
