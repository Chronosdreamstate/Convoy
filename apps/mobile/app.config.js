/** @type {import('expo/config').ExpoConfig} */
const baseConfig = {
  name: 'CORTEGE',
  slug: 'convoy',
  description: 'Real-time group navigation and push-to-talk for car enthusiasts. Drive together.',
  version: '1.0.0',
  sdkVersion: '54.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  scheme: 'convoy',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#0A0A0A',
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'app.convoy.mobile',
    buildNumber: '1',
    usesAppleSignIn: true,
    associatedDomains: ['applinks:convoy.app'],
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'CORTEGE uses your location to keep your convoy in sync and find nearby groups.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'CORTEGE uses background location to update your position in the convoy.',
      NSMicrophoneUsageDescription:
        'CORTEGE needs microphone access for push-to-talk radio between convoy members.',
      NSCameraUsageDescription: 'CORTEGE uses your camera for profile and vehicle photos.',
      NSSupportsLiveActivities: true,
      NSSupportsLiveActivitiesFrequentUpdates: true,
      ITSAppUsesNonExemptEncryption: false,
      NSUserActivityTypes: [
        'com.convoy.startConvoy',
        'com.convoy.joinConvoy',
        'com.convoy.ptt',
        'com.convoy.checkGap',
      ],
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0A0A0A',
    },
    package: 'app.convoy.mobile',
    versionCode: 1,
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [
          { scheme: 'https', host: 'convoy.app', pathPrefix: '/join' },
          { scheme: 'https', host: 'convoy.app', pathPrefix: '/invite' },
          { scheme: 'https', host: 'convoy.app', pathPrefix: '/group' },
          { scheme: 'convoy' },
        ],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
    permissions: [
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'RECORD_AUDIO',
      'CAMERA',
      'VIBRATE',
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_LOCATION',
    ],
  },
  web: {
    bundler: 'metro',
    favicon: './assets/favicon.png',
  },
  updates: {
    fallbackToCacheTimeout: 0,
    checkAutomatically: 'ON_LOAD',
  },
  plugins: [
    'expo-updates',
    'expo-router',
    'expo-secure-store',
    'expo-apple-authentication',
    'expo-camera',
    'expo-web-browser',
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'CORTEGE needs your location to track your position in the convoy and alert your crew if you fall behind.',
        locationAlwaysPermission:
          'CORTEGE tracks your location in the background so your convoy can see you even when your screen is off.',
        locationWhenInUsePermission:
          'CORTEGE uses your location to keep your convoy in sync and find nearby groups.',
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
      },
    ],
    [
      '@rnmapbox/maps',
      {
        RNMapboxMapsDownloadToken: process.env.MAPBOX_DOWNLOADS_TOKEN,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    router: {},
    // Numeric App Store id used by the post-drive review prompt and the
    // Settings "rate" link (https://apps.apple.com/app/id<ID>). Set
    // EXPO_PUBLIC_APP_STORE_ID once the app is published; the all-zero
    // placeholder keeps unconfigured/dev builds working unchanged.
    appStoreId: process.env.EXPO_PUBLIC_APP_STORE_ID || '0000000000',
    eas: {
      projectId: '10e02def-bbdc-482d-bbca-0486b648d655',
    },
  },
  owner: 'chronoss',
};

// Google sign-in (expo-auth-session) redirects back into the app via the
// reversed iOS OAuth client ID; register it as a URL scheme only when the
// client ID is configured so unconfigured builds stay unchanged.
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
if (googleIosClientId) {
  const reversed = `com.googleusercontent.apps.${googleIosClientId.replace('.apps.googleusercontent.com', '')}`;
  baseConfig.ios.infoPlist.CFBundleURLTypes = [{ CFBundleURLSchemes: [reversed] }];
}

module.exports = { expo: baseConfig };
