# Anonomi Maps: integration reference

This document describes the conventions used by **Maps** for serving offline tile maps over Tor. Use it to implement or update the Online Maps feature in Anonomi Messenger (Android).

---

## Overview

Maps downloads map tiles and writes them to network storage. An nginx server serves those files as static files over a Tor hidden service. There is no dynamic API. Everything is static files.

The onion address is deployment-specific and is not published here. Every
address and map ID below is a placeholder. Substitute the ones for the
deployment you are integrating against.

```
http://<your-onion-address>.onion
```

---

## File layout on disk / URL structure

```
{onionUrl}/
  disco.json                          ← server-level discovery file
  {mapId}/
    map.json                          ← per-map metadata
    {z}/
      {x}/
        {y}.png                       ← tile files (standard slippy map format)
```

### Map IDs

Map IDs are **UUID v4** strings:
```
3f2a9c14-7b6d-4e58-9a01-c5d8e2f41b7a
```

They are used directly as folder names and URL path segments, and are written
as `<map-id>` in the examples below. They are cryptographically random and unguessable, and that is intentional: non-discoverable maps are "hidden" by their unguessable ID (capability URL pattern).

---

## `disco.json`: server discovery file

Served at: `GET {onionUrl}/disco.json`

Lists all maps marked as **discoverable** by the server admin. Non-discoverable maps exist on disk but are not listed here. They can only be accessed if you know the map ID (e.g. via a shared QR code).

### Format

```json
{
  "v": 1,
  "generated": "2026-03-03T19:00:00.000Z",
  "maps": [
    {
      "id": "<map-id>",
      "name": "Portugal",
      "description": "Portugal mainland offline map",
      "zoomMin": 0,
      "zoomMax": 14,
      "bbox": {
        "north": 42.15,
        "south": 36.84,
        "west": -9.52,
        "east": -6.19
      }
    }
  ]
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `v` | number | Schema version. Currently `1`. |
| `generated` | ISO 8601 string | When the file was last written. |
| `maps` | array | Discoverable maps. May be empty. |
| `maps[].id` | string | UUID v4. Used to construct all URLs for this map. |
| `maps[].name` | string | Human-readable map name. |
| `maps[].description` | string | May be empty string. |
| `maps[].zoomMin` | number | Optional. Minimum zoom level available. |
| `maps[].zoomMax` | number | Optional. Maximum zoom level available. |
| `maps[].bbox` | object | Optional. Bounding box of the covered area. |
| `maps[].bbox.north/south/east/west` | number | Decimal degrees. |

`zoomMin`, `zoomMax`, and `bbox` are omitted if the map has no coverages yet.

---

## `map.json`: per-map metadata

Served at: `GET {onionUrl}/{mapId}/map.json`

Also accessible at: `GET {onionUrl}/{mapId}` (nginx falls back to `map.json` for directory paths)

This file is written for **all** maps (discoverable and non-discoverable). It contains everything needed to use the map.

### Format

```json
{
  "v": 1,
  "id": "<map-id>",
  "name": "Portugal",
  "description": "Portugal mainland offline map",
  "generated": "2026-03-03T19:00:00.000Z",
  "tileUrl": "http://<your-onion-address>.onion/<map-id>/{z}/{x}/{y}.png",
  "zoomMin": 0,
  "zoomMax": 14,
  "bbox": {
    "north": 42.15,
    "south": 36.84,
    "west": -9.52,
    "east": -6.19
  }
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `v` | number | Schema version. Currently `1`. |
| `id` | string | UUID v4 map identifier. |
| `name` | string | Human-readable map name. |
| `description` | string | May be empty string. |
| `generated` | ISO 8601 string | When the file was last written. |
| `tileUrl` | string | Optional. Full tile URL template with `{z}`, `{x}`, `{y}` placeholders. Omitted if no onion URL is configured. |
| `zoomMin` | number | Optional. Minimum zoom level available. |
| `zoomMax` | number | Optional. Maximum zoom level available. |
| `bbox` | object | Optional. Bounding box of the covered area. |

---

## Tile URL format

```
{onionUrl}/{mapId}/{z}/{x}/{y}.png
```

Standard slippy map / XYZ tile format. Tiles are 256×256 PNG files.

### Example (zoom 0, whole world in one tile)
```
http://<your-onion-address>.onion/<map-id>/0/0/0.png
```

### Example (zoom 1, Europe/Africa quadrant)
```
http://<your-onion-address>.onion/<map-id>/1/1/0.png
```

Tiles outside the downloaded coverage will return **404**. Messenger should handle 404 gracefully (show empty tile or cached fallback).

---

## QR code share conventions

The Maps dashboard generates two types of QR codes:

### Server share QR
Contains: `{onionUrl}`
```
http://<your-onion-address>.onion
```
Scanning this should trigger **server discovery**: fetch `{url}/disco.json` and present the list of available maps to the user.

### Map share QR
Contains: `{onionUrl}/{mapId}`
```
http://<your-onion-address>.onion/<map-id>
```
Scanning this should trigger **direct map import**: fetch `{url}/map.json` (nginx serves it when accessing a directory path) and import that specific map.

### How to distinguish QR types in Messenger

Check the URL path:
- No path (just the onion host) → server share → fetch `disco.json`
- Has a path segment (UUID v4) → map share → fetch `{path}/map.json`

---

## Suggested Messenger integration flow

### Scanning a server share QR
1. Detect URL is an onion address with no path
2. Fetch `{url}/disco.json`
3. Show list of maps with name, description, bbox preview
4. User selects one or more maps to add
5. Store `tileUrl` template + metadata locally

### Scanning a map share QR
1. Detect URL is an onion address with a UUID path
2. Fetch `{url}/map.json` (or `{url}`, same result due to nginx config)
3. Show map details (name, description, bbox, zoom range)
4. User confirms import
5. Store `tileUrl` template + metadata locally

### Using tiles
- Use `tileUrl` from `map.json` as the tile source template
- Replace `{z}`, `{x}`, `{y}` with actual values
- All requests go over Tor (onion address)
- Handle 404 gracefully, since not all zoom levels / areas may be downloaded
- Recommended cache headers: tiles have `Cache-Control: public, max-age=86400`

---

## Notes

- The nginx server has no directory listing, so you cannot enumerate maps by browsing
- Non-discoverable maps are not in `disco.json` but their tiles and `map.json` are fully accessible if you know the map ID
- `disco.json` is regenerated whenever maps are created, deleted, or their discoverable status changes
- `map.json` is regenerated whenever map metadata or coverage configuration changes
- All content is static, with no authentication and no dynamic API
