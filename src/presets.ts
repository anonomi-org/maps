import type { Bbox } from "./types"

export type Preset = {
  id: string
  name: string
  continent?: string
  bbox: Bbox
  defaultMarginKm: number
}

export const PRESETS: Preset[] = [
  // ── World ──────────────────────────────────────────────────────────────
  {
    id: "world",
    name: "World",
    bbox: { north: 85, south: -85, west: -180, east: 180 },
    defaultMarginKm: 0,
  },

  // ── Africa ─────────────────────────────────────────────────────────────
  {
    id: "africa",
    name: "Africa",
    continent: "Africa",
    bbox: { north: 37.5, south: -35, west: -18, east: 52 },
    defaultMarginKm: 10,
  },
  {
    id: "nigeria",
    name: "Nigeria",
    continent: "Africa",
    bbox: { north: 13.9, south: 4.3, west: 2.7, east: 14.7 },
    defaultMarginKm: 5,
  },
  {
    id: "ethiopia",
    name: "Ethiopia",
    continent: "Africa",
    bbox: { north: 15.0, south: 3.4, west: 33.0, east: 48.0 },
    defaultMarginKm: 0,
  },
  {
    id: "egypt",
    name: "Egypt",
    continent: "Africa",
    bbox: { north: 31.7, south: 22.0, west: 24.7, east: 37.1 },
    defaultMarginKm: 5,
  },
  {
    id: "south-africa",
    name: "South Africa",
    continent: "Africa",
    bbox: { north: -22.1, south: -34.8, west: 16.5, east: 32.9 },
    defaultMarginKm: 10,
  },
  {
    id: "kenya",
    name: "Kenya",
    continent: "Africa",
    bbox: { north: 5.0, south: -4.7, west: 34.0, east: 42.0 },
    defaultMarginKm: 5,
  },
  {
    id: "morocco",
    name: "Morocco",
    continent: "Africa",
    bbox: { north: 35.9, south: 27.7, west: -13.2, east: -1.0 },
    defaultMarginKm: 10,
  },
  {
    id: "ghana",
    name: "Ghana",
    continent: "Africa",
    bbox: { north: 11.2, south: 4.7, west: -3.3, east: 1.2 },
    defaultMarginKm: 5,
  },
  {
    id: "tanzania",
    name: "Tanzania",
    continent: "Africa",
    bbox: { north: -1.0, south: -11.7, west: 29.3, east: 40.5 },
    defaultMarginKm: 5,
  },
  {
    id: "algeria",
    name: "Algeria",
    continent: "Africa",
    bbox: { north: 37.1, south: 18.9, west: -8.7, east: 12.0 },
    defaultMarginKm: 5,
  },

  // ── Antarctica ─────────────────────────────────────────────────────────
  {
    id: "antarctica",
    name: "Antarctica",
    continent: "Antarctica",
    bbox: { north: -60, south: -85, west: -180, east: 180 },
    defaultMarginKm: 0,
  },

  // ── Asia ───────────────────────────────────────────────────────────────
  {
    id: "asia",
    name: "Asia",
    continent: "Asia",
    bbox: { north: 77, south: -10, west: 26, east: 145 },
    defaultMarginKm: 10,
  },
  {
    id: "china",
    name: "China",
    continent: "Asia",
    bbox: { north: 53.6, south: 18.2, west: 73.5, east: 135.1 },
    defaultMarginKm: 10,
  },
  {
    id: "india",
    name: "India",
    continent: "Asia",
    bbox: { north: 35.5, south: 6.7, west: 68.1, east: 97.4 },
    defaultMarginKm: 10,
  },
  {
    id: "indonesia",
    name: "Indonesia",
    continent: "Asia",
    bbox: { north: 6.1, south: -11.0, west: 95.0, east: 141.0 },
    defaultMarginKm: 10,
  },
  {
    id: "japan",
    name: "Japan",
    continent: "Asia",
    bbox: { north: 45.5, south: 24.0, west: 122.9, east: 153.9 },
    defaultMarginKm: 10,
  },
  {
    id: "south-korea",
    name: "South Korea",
    continent: "Asia",
    bbox: { north: 38.6, south: 33.1, west: 125.9, east: 130.0 },
    defaultMarginKm: 10,
  },
  {
    id: "iran",
    name: "Iran",
    continent: "Asia",
    bbox: { north: 39.8, south: 25.1, west: 44.0, east: 63.3 },
    defaultMarginKm: 5,
  },
  {
    id: "turkey",
    name: "Turkey",
    continent: "Asia",
    bbox: { north: 42.1, south: 35.8, west: 26.0, east: 44.8 },
    defaultMarginKm: 10,
  },
  {
    id: "saudi-arabia",
    name: "Saudi Arabia",
    continent: "Asia",
    bbox: { north: 32.2, south: 16.4, west: 34.6, east: 55.7 },
    defaultMarginKm: 5,
  },
  {
    id: "pakistan",
    name: "Pakistan",
    continent: "Asia",
    bbox: { north: 37.1, south: 23.7, west: 61.0, east: 77.2 },
    defaultMarginKm: 5,
  },
  {
    id: "vietnam",
    name: "Vietnam",
    continent: "Asia",
    bbox: { north: 23.4, south: 8.6, west: 102.1, east: 109.5 },
    defaultMarginKm: 10,
  },
  {
    id: "thailand",
    name: "Thailand",
    continent: "Asia",
    bbox: { north: 20.5, south: 5.6, west: 97.3, east: 105.7 },
    defaultMarginKm: 10,
  },
  {
    id: "bangladesh",
    name: "Bangladesh",
    continent: "Asia",
    bbox: { north: 26.6, south: 20.7, west: 88.0, east: 92.7 },
    defaultMarginKm: 5,
  },

  // ── Europe ─────────────────────────────────────────────────────────────
  {
    id: "europe",
    name: "Europe",
    continent: "Europe",
    bbox: { north: 71.2, south: 35.0, west: -25.0, east: 45.0 },
    defaultMarginKm: 10,
  },
  {
    id: "germany",
    name: "Germany",
    continent: "Europe",
    bbox: { north: 55.1, south: 47.3, west: 5.9, east: 15.0 },
    defaultMarginKm: 5,
  },
  {
    id: "france",
    name: "France",
    continent: "Europe",
    bbox: { north: 51.1, south: 42.3, west: -5.2, east: 9.6 },
    defaultMarginKm: 10,
  },
  {
    id: "united-kingdom",
    name: "United Kingdom",
    continent: "Europe",
    bbox: { north: 60.9, south: 49.9, west: -8.2, east: 1.8 },
    defaultMarginKm: 10,
  },
  {
    id: "spain",
    name: "Spain",
    continent: "Europe",
    bbox: { north: 43.8, south: 36.0, west: -9.3, east: 4.3 },
    defaultMarginKm: 10,
  },
  {
    id: "portugal",
    name: "Portugal",
    continent: "Europe",
    bbox: { north: 42.2, south: 36.8, west: -9.6, east: -6.2 },
    defaultMarginKm: 10,
  },
  {
    id: "italy",
    name: "Italy",
    continent: "Europe",
    bbox: { north: 47.1, south: 37.0, west: 6.6, east: 18.5 },
    defaultMarginKm: 10,
  },
  {
    id: "netherlands",
    name: "Netherlands",
    continent: "Europe",
    bbox: { north: 53.5, south: 50.7, west: 3.4, east: 7.2 },
    defaultMarginKm: 10,
  },
  {
    id: "poland",
    name: "Poland",
    continent: "Europe",
    bbox: { north: 54.8, south: 49.0, west: 14.1, east: 24.2 },
    defaultMarginKm: 5,
  },
  {
    id: "ukraine",
    name: "Ukraine",
    continent: "Europe",
    bbox: { north: 52.4, south: 44.4, west: 22.1, east: 40.2 },
    defaultMarginKm: 5,
  },
  {
    id: "sweden",
    name: "Sweden",
    continent: "Europe",
    bbox: { north: 69.1, south: 55.3, west: 11.1, east: 24.2 },
    defaultMarginKm: 10,
  },
  {
    id: "norway",
    name: "Norway",
    continent: "Europe",
    bbox: { north: 71.2, south: 57.9, west: 4.6, east: 31.2 },
    defaultMarginKm: 10,
  },
  {
    id: "greece",
    name: "Greece",
    continent: "Europe",
    bbox: { north: 41.7, south: 34.8, west: 19.4, east: 29.7 },
    defaultMarginKm: 10,
  },
  {
    id: "switzerland",
    name: "Switzerland",
    continent: "Europe",
    bbox: { north: 47.8, south: 45.8, west: 5.9, east: 10.5 },
    defaultMarginKm: 0,
  },

  // ── North America ──────────────────────────────────────────────────────
  {
    id: "north-america",
    name: "North America",
    continent: "North America",
    bbox: { north: 83, south: 7, west: -168, east: -52 },
    defaultMarginKm: 10,
  },
  {
    id: "usa",
    name: "United States",
    continent: "North America",
    bbox: { north: 49.4, south: 24.4, west: -125.0, east: -66.9 },
    defaultMarginKm: 10,
  },
  {
    id: "canada",
    name: "Canada",
    continent: "North America",
    bbox: { north: 83.1, south: 41.7, west: -141.0, east: -52.6 },
    defaultMarginKm: 10,
  },
  {
    id: "mexico",
    name: "Mexico",
    continent: "North America",
    bbox: { north: 32.7, south: 14.5, west: -117.1, east: -86.7 },
    defaultMarginKm: 10,
  },
  {
    id: "cuba",
    name: "Cuba",
    continent: "North America",
    bbox: { north: 23.3, south: 19.8, west: -85.0, east: -74.1 },
    defaultMarginKm: 10,
  },
  {
    id: "haiti",
    name: "Haiti",
    continent: "North America",
    bbox: { north: 20.1, south: 18.0, west: -74.5, east: -71.6 },
    defaultMarginKm: 10,
  },
  {
    id: "dominican-republic",
    name: "Dominican Republic",
    continent: "North America",
    bbox: { north: 19.9, south: 17.5, west: -72.0, east: -68.3 },
    defaultMarginKm: 10,
  },
  {
    id: "guatemala",
    name: "Guatemala",
    continent: "North America",
    bbox: { north: 17.8, south: 13.7, west: -92.2, east: -88.2 },
    defaultMarginKm: 5,
  },

  // ── Oceania ────────────────────────────────────────────────────────────
  {
    id: "oceania",
    name: "Oceania",
    continent: "Oceania",
    bbox: { north: 28, south: -50, west: 112, east: 180 },
    defaultMarginKm: 10,
  },
  {
    id: "australia",
    name: "Australia",
    continent: "Oceania",
    bbox: { north: -10.7, south: -43.6, west: 113.3, east: 153.6 },
    defaultMarginKm: 10,
  },
  {
    id: "new-zealand",
    name: "New Zealand",
    continent: "Oceania",
    bbox: { north: -34.4, south: -47.3, west: 166.4, east: 178.6 },
    defaultMarginKm: 10,
  },
  {
    id: "papua-new-guinea",
    name: "Papua New Guinea",
    continent: "Oceania",
    bbox: { north: -1.3, south: -11.7, west: 140.8, east: 155.7 },
    defaultMarginKm: 10,
  },
  {
    id: "fiji",
    name: "Fiji",
    continent: "Oceania",
    bbox: { north: -15.7, south: -19.2, west: 177.3, east: -179.8 },
    defaultMarginKm: 10,
  },

  // ── South America ──────────────────────────────────────────────────────
  {
    id: "south-america",
    name: "South America",
    continent: "South America",
    bbox: { north: 13, south: -56, west: -82, east: -34 },
    defaultMarginKm: 10,
  },
  {
    id: "brazil",
    name: "Brazil",
    continent: "South America",
    bbox: { north: 5.3, south: -33.7, west: -73.9, east: -34.8 },
    defaultMarginKm: 10,
  },
  {
    id: "argentina",
    name: "Argentina",
    continent: "South America",
    bbox: { north: -21.8, south: -55.1, west: -73.6, east: -53.6 },
    defaultMarginKm: 10,
  },
  {
    id: "colombia",
    name: "Colombia",
    continent: "South America",
    bbox: { north: 13.4, south: -4.2, west: -79.0, east: -66.9 },
    defaultMarginKm: 10,
  },
  {
    id: "chile",
    name: "Chile",
    continent: "South America",
    bbox: { north: -17.5, south: -55.9, west: -75.7, east: -66.1 },
    defaultMarginKm: 10,
  },
  {
    id: "peru",
    name: "Peru",
    continent: "South America",
    bbox: { north: -0.0, south: -18.4, west: -81.3, east: -68.7 },
    defaultMarginKm: 10,
  },
  {
    id: "venezuela",
    name: "Venezuela",
    continent: "South America",
    bbox: { north: 12.2, south: 0.6, west: -73.4, east: -59.8 },
    defaultMarginKm: 10,
  },
  {
    id: "ecuador",
    name: "Ecuador",
    continent: "South America",
    bbox: { north: 1.5, south: -5.0, west: -80.9, east: -75.2 },
    defaultMarginKm: 10,
  },
  {
    id: "bolivia",
    name: "Bolivia",
    continent: "South America",
    bbox: { north: -9.7, south: -22.9, west: -69.6, east: -57.5 },
    defaultMarginKm: 0,
  },
  {
    id: "uruguay",
    name: "Uruguay",
    continent: "South America",
    bbox: { north: -30.1, south: -34.9, west: -58.4, east: -53.1 },
    defaultMarginKm: 10,
  },
]

export const CONTINENTS = [
  "Africa",
  "Antarctica",
  "Asia",
  "Europe",
  "North America",
  "Oceania",
  "South America",
] as const

export function getPresetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id)
}

export function getPresetsByContinent(continent: string): Preset[] {
  return PRESETS.filter((p) => p.continent === continent)
}
