// ─── useFuelPrice ─────────────────────────────────────────────────────────────
// Returns a mock estimated fuel price for waypoints of type 'fuel'.
// Free reliable real-time fuel price APIs are limited, so we use a static mock
// with slight randomization to simulate realistic regional variance.

interface FuelPrice {
  pricePerLitre: string;
  currency: string;
  isEstimate: boolean;
}

export function useFuelPrice(type: string): FuelPrice | null {
  if (type !== 'fuel') return null;

  // Realistic mock: $1.45–1.65/L CAD range
  const basePrice = 1.45;
  const variation = Math.round(Math.random() * 20) / 100;
  return {
    pricePerLitre: (basePrice + variation).toFixed(2),
    currency: 'CAD',
    isEstimate: true,
  };
}
