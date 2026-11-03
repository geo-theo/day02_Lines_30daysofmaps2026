// EPSG:6514 — NAD83(2011) / Montana, meters, Lambert Conformal Conic 2SP.
// Definition: https://www.opengis.net/def/crs/EPSG/0/6514
// Ellipsoidal equations: Snyder, USGS Professional Paper 1395, pp. 107–109.
// https://pubs.usgs.gov/pp/1395/report.pdf
//
// The input GeoJSON uses longitude/latitude degrees despite its filenames.
// Its datum realization/epoch is unspecified. We treat geographic positions
// as NAD83(2011) for this display (a ballpark datum assumption), then apply the
// full GRS80 ellipsoidal projection. This is not a survey-grade datum shift.
const radians = Math.PI / 180;
const a = 6378137;
const flattening = 1 / 298.257222101;
const e = Math.sqrt(2 * flattening - flattening ** 2);
const phi0 = 44.25 * radians;
const lambda0 = -109.5 * radians;
const phi1 = 49 * radians;
const phi2 = 45 * radians;

function m(phi) {
  return Math.cos(phi) / Math.sqrt(1 - (e * Math.sin(phi)) ** 2);
}

function t(phi) {
  const esin = e * Math.sin(phi);
  return Math.tan(Math.PI / 4 - phi / 2) /
    ((1 - esin) / (1 + esin)) ** (e / 2);
}

const n = Math.log(m(phi1) / m(phi2)) / Math.log(t(phi1) / t(phi2));
const F = m(phi1) / (n * t(phi1) ** n);
const rho0 = a * F * t(phi0) ** n;

/** Convert [longitude, latitude] degrees to EPSG:6514 [easting, northing] meters. */
export function projectPosition(position) {
  const [longitude, latitude] = position;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
      longitude < -180 || longitude > 180 || latitude <= -90 || latitude >= 90) {
    throw new Error('Expected longitude/latitude degrees, not already projected coordinates.');
  }
  const rho = a * F * t(latitude * radians) ** n;
  const theta = n * (longitude * radians - lambda0);
  return [600000 + rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
}

/** Return a new collection; never alter the original feature coordinates. */
export function projectCollection(collection) {
  if (collection.type !== 'FeatureCollection' || !collection.features?.length) {
    throw new Error('Expected a nonempty GeoJSON FeatureCollection.');
  }
  return {
    type: 'FeatureCollection',
    features: collection.features.map(feature => {
      const { type, coordinates } = feature.geometry;
      let projected;
      if (type === 'Point') projected = projectPosition(coordinates);
      else if (type === 'LineString') projected = coordinates.map(projectPosition);
      else if (type === 'MultiLineString') {
        projected = coordinates.map(line => line.map(projectPosition));
      } else throw new Error(`Unsupported geometry: ${type}`);
      // Rebuild geometry so any source bbox does not survive the CRS change.
      return { type: 'Feature', id: feature.id, properties: { ...feature.properties },
        geometry: { type, coordinates: projected } };
    }),
  };
}
