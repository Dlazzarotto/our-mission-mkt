// ============================================================
// Google Places — coleta real de concorrentes no raio
//
// Fluxo: ZIP code -> Geocoding API -> lat/lng -> Text Search (New) restrita
// à área circular. Retorna empresas REAIS, com nota e nº de avaliações reais.
//
// Política do provedor: conteúdo de Places não pode virar acervo permanente;
// place_id é a exceção explicitamente permitida. Por isso gravamos fetched_at
// e a interface exibe a atribuição ao Google.
// ============================================================

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// Places aceita raio de até 50.000 metros por consulta.
const MAX_RADIUS_METERS = 50_000;
const MILES_TO_METERS = 1609.34;

export type GeoPoint = { latitude: number; longitude: number; formattedAddress?: string };

export type PlaceCompetitor = {
  placeId: string;
  name: string;
  address: string | null;
  website: string | null;
  googleMapsUri: string | null;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  businessHours: string | null;
  primaryType: string | null;
  distanceMiles: number | null;
};

function requireKey() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error(
      "GOOGLE_MAPS_API_KEY não configurada — a coleta de concorrentes reais está desativada.",
    );
  }
  return key;
}

export async function geocodeZip(zipCode: string, countryCode = "US"): Promise<GeoPoint> {
  const key = requireKey();
  const url = `${GEOCODE_URL}?components=postal_code:${encodeURIComponent(zipCode)}|country:${countryCode}&key=${key}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Geocoding falhou (HTTP ${response.status}).`);
  }
  const data = await response.json();
  if (data.status !== "OK" || !data.results?.length) {
    throw new Error(`ZIP code ${zipCode} não foi localizado (${data.status}).`);
  }
  const first = data.results[0];
  return {
    latitude: first.geometry.location.lat,
    longitude: first.geometry.location.lng,
    formattedAddress: first.formatted_address,
  };
}

function haversineMiles(a: GeoPoint, b: { latitude: number; longitude: number }) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Number((2 * earthRadiusMiles * Math.asin(Math.sqrt(h))).toFixed(2));
}

/**
 * Busca empresas do segmento dentro do raio.
 * O FieldMask pede só o necessário — campos extras aumentam a cobrança.
 */
export async function searchCompetitors(
  query: string,
  center: GeoPoint,
  radiusMiles: number,
  maxResults = 20,
): Promise<PlaceCompetitor[]> {
  const key = requireKey();
  const radiusMeters = Math.min(radiusMiles * MILES_TO_METERS, MAX_RADIUS_METERS);

  const response = await fetch(TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.websiteUri",
        "places.googleMapsUri",
        "places.rating",
        "places.userRatingCount",
        "places.priceLevel",
        "places.primaryTypeDisplayName",
        "places.regularOpeningHours.weekdayDescriptions",
        "places.location",
      ].join(","),
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: Math.min(maxResults, 20),
      locationBias: {
        circle: {
          center: { latitude: center.latitude, longitude: center.longitude },
          radius: radiusMeters,
        },
      },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Places falhou (HTTP ${response.status}). ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const places = Array.isArray(data.places) ? data.places : [];

  return places.map((place: Record<string, never>) => {
    const location = place.location as { latitude?: number; longitude?: number } | undefined;
    const hours = place.regularOpeningHours as { weekdayDescriptions?: string[] } | undefined;
    return {
      placeId: String(place.id ?? ""),
      name: String((place.displayName as { text?: string } | undefined)?.text ?? "Sem nome"),
      address: (place.formattedAddress as string | undefined) ?? null,
      website: (place.websiteUri as string | undefined) ?? null,
      googleMapsUri: (place.googleMapsUri as string | undefined) ?? null,
      rating: typeof place.rating === "number" ? (place.rating as number) : null,
      reviewCount:
        typeof place.userRatingCount === "number" ? (place.userRatingCount as number) : null,
      priceLevel: (place.priceLevel as string | undefined) ?? null,
      businessHours: hours?.weekdayDescriptions?.join(" | ") ?? null,
      primaryType:
        (place.primaryTypeDisplayName as { text?: string } | undefined)?.text ?? null,
      distanceMiles:
        location?.latitude && location?.longitude
          ? haversineMiles(center, { latitude: location.latitude, longitude: location.longitude })
          : null,
    };
  });
}

/** Converte o priceLevel do Places para a faixa usada no banco. */
export function toPriceBand(priceLevel: string | null): "budget" | "mid" | "premium" | "unknown" {
  switch (priceLevel) {
    case "PRICE_LEVEL_FREE":
    case "PRICE_LEVEL_INEXPENSIVE":
      return "budget";
    case "PRICE_LEVEL_MODERATE":
      return "mid";
    case "PRICE_LEVEL_EXPENSIVE":
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return "premium";
    default:
      return "unknown";
  }
}
