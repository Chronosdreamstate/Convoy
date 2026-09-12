import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { FileSystemUploadType } from 'expo-file-system/legacy';
import { apiClient } from './apiClient';
import { readUploadedUrl, uploadErrorMessage } from '../utils/upload';

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

  // Through the shared helper, like ProfileScreen and GarageScreen. The bare
  // `JSON.parse(uploadResult.body)` this replaced threw straight out of the
  // function for any 2xx whose body isn't JSON — a proxy's HTML error page, a
  // truncated response — so the caller's `await` rejected instead of showing
  // the "Upload Failed" alert two lines up. readUploadedUrl also surfaces the
  // server's own reason ("File too large (max 10 MB)") rather than the
  // generic line, and catches a 2xx that carries no `url` at all.
  let url: string;
  try {
    url = readUploadedUrl(uploadResult);
  } catch (err) {
    Alert.alert('Upload Failed', uploadErrorMessage(err, 'Could not upload the photo. Please try again.'));
    return null;
  }

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
