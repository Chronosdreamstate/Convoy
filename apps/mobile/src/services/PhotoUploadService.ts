import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { FileSystemUploadType } from 'expo-file-system';
import { apiClient } from './apiClient';

export async function pickAndUploadPhoto(
  groupId: string,
  accessToken: string,
  apiUrl: string,
): Promise<{ id: string; photoUrl: string } | null> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert('Permission Required', 'Please allow access to your photo library to add drive photos.');
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.8,
    allowsEditing: false,
  });

  if (result.canceled) return null;

  const asset = result.assets[0];

  const uploadResult = await FileSystem.uploadAsync(
    `${apiUrl}/api/v1/uploads/photo`,
    asset.uri,
    {
      httpMethod: 'POST',
      uploadType: FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType: asset.mimeType ?? 'image/jpeg',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    Alert.alert('Upload Failed', 'Could not upload the photo. Please try again.');
    return null;
  }

  const { url } = JSON.parse(uploadResult.body) as { url: string };

  let photo: { id: string };
  try {
    const res = await apiClient.post<{ photo: { id: string } }>(
      `/api/v1/groups/${groupId}/photos`,
      { photoUrl: url },
    );
    photo = res.data.photo;
  } catch {
    Alert.alert('Upload Failed', 'Could not save the photo to the group. Please try again.');
    return null;
  }
  return { id: photo.id, photoUrl: url };
}
