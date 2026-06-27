import { useEffect, useState } from 'react';

interface WeatherParams {
  latitude: number | null;
  longitude: number | null;
}

interface WeatherResult {
  tempC: number | null;
  windspeedKmh: number | null;
  weatherCode: number | null;
  emoji: string | null;
  isLoading: boolean;
}

function getWeatherEmoji(code: number): string {
  if (code === 0) return '☀️';
  if (code === 1 || code === 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code === 95) return '⛈️';
  return '🌡️';
}

/**
 * Fetches current weather near the given coordinates using the Open-Meteo free API.
 * Refreshes every 10 minutes. Returns null data when no location is available.
 */
export function useWeather({ latitude, longitude }: WeatherParams): WeatherResult {
  const [isLoading, setIsLoading] = useState(false);
  const [data, setData] = useState<{ tempC: number; windspeedKmh: number; weatherCode: number } | null>(null);

  useEffect(() => {
    if (latitude == null || longitude == null) {
      setData(null);
      return;
    }

    let cancelled = false;

    const fetchWeather = async () => {
      setIsLoading(true);
      try {
        const url =
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
        const res = await fetch(url);
        const json = (await res.json()) as {
          current_weather?: { temperature: number; windspeed: number; weathercode: number };
        };
        if (!cancelled && json.current_weather) {
          setData({
            tempC: json.current_weather.temperature,
            windspeedKmh: json.current_weather.windspeed,
            weatherCode: json.current_weather.weathercode,
          });
        }
      } catch {
        // Weather is non-critical — silently swallow errors
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void fetchWeather();

    // Refresh every 10 minutes
    const interval = setInterval(() => { void fetchWeather(); }, 10 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [latitude, longitude]);

  return {
    tempC: data?.tempC ?? null,
    windspeedKmh: data?.windspeedKmh ?? null,
    weatherCode: data?.weatherCode ?? null,
    emoji: data != null ? getWeatherEmoji(data.weatherCode) : null,
    isLoading,
  };
}
