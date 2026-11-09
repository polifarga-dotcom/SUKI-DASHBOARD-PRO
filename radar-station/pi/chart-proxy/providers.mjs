// Katalog der Karten-/Bildanbieter. Nur Anbieter, deren Bedingungen die Nutzung in einer privaten App erlauben.
// mode:  'cache' = über den Pi, Kacheln werden gespeichert (auch offline nutzbar)
//        'live'  = über den Pi, ohne Speichern (Bedingungen erlauben kein Cachen)
//        'direct'= Browser holt direkt beim Anbieter (Proxy/Cache laut Bedingungen nicht erlaubt)
// prefetch: Revier-Download erlaubt?
// kind: 'base' | 'satellite' | 'depth' | 'overlay'

const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

export const PROVIDERS = [
	{
		id: 'osm',
		name: 'OpenStreetMap',
		kind: 'base',
		type: 'xyz',
		url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
		ext: 'png',
		maxNativeZoom: 19,
		mode: 'cache',
		prefetch: false, // OSM Tile Usage Policy: kein Massen-Download
		ttlDays: 7,
		attribution: '© OpenStreetMap contributors'
	},
	{
		id: 'seamark',
		name: 'OpenSeaMap',
		kind: 'overlay',
		type: 'xyz',
		url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
		ext: 'png',
		maxNativeZoom: 18,
		mode: 'cache',
		prefetch: false,
		ttlDays: 7,
		attribution: 'Seamarks © OpenSeaMap'
	},
	{
		id: 'eox',
		resolution: '10 m',
		dateKind: 'year',
		name: 'Sentinel-2 cloudless (EOX)',
		kind: 'satellite',
		type: 'xyz',
		url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-{year}_3857/default/g/{z}/{y}/{x}.jpg',
		ext: 'jpg',
		maxNativeZoom: 15,
		mode: 'cache',
		prefetch: true,
		ttlDays: 365,
		options: { year: { type: 'select', values: ['2025', '2024', '2023', '2022', '2021', '2020'], default: '2025' } },
		attribution: 'Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data)',
		info: 'Annual cloud-free mosaic, 10 m. Free for non-commercial use.'
	},
	{
		id: 'copernicus',
		resolution: '10 m',
		dateKind: 'copernicus',
		name: 'Sentinel-2 current (Copernicus)',
		kind: 'satellite',
		type: 'wms',
		url: 'https://sh.dataspace.copernicus.eu/ogc/wms/{key}',
		layers: '{layer}',
		extraParams: 'TIME={from}/{to}&MAXCC={maxcc}&PRIORITY=mostRecent&SHOWLOGO=false',
		ext: 'jpg',
		format: 'image/jpeg',
		maxNativeZoom: 15,
		needsKey: true,
		keyLabel: 'Configuration (instance) ID',
		keyUrl: 'https://shapps.dataspace.copernicus.eu/dashboard/',
		mode: 'cache',
		prefetch: true,
		prefetchMax: 2000, // Kontingent schonen
		ttlDays: 1,
		options: {
			layer: { type: 'text', default: 'TRUE_COLOR' },
			days: { type: 'number', min: 3, max: 365, default: 30 },
			maxcc: { type: 'number', min: 0, max: 100, default: 20 }
		},
		attribution: 'Contains modified Copernicus Sentinel data, processed by Copernicus Data Space Ecosystem',
		info: 'Most recent Sentinel-2 image (every ~5 days, 10 m). Free account, monthly quota.'
	},
	{
		id: 'gibs',
		resolution: '250 m',
		dateKind: 'daily',
		name: 'NASA daily (MODIS/VIIRS)',
		kind: 'satellite',
		type: 'xyz',
		url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{product}/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
		ext: 'jpg',
		maxNativeZoom: 9,
		mode: 'cache',
		prefetch: true,
		ttlDays: 2,
		options: {
			product: {
				type: 'select',
				values: ['VIIRS_SNPP_CorrectedReflectance_TrueColor', 'MODIS_Terra_CorrectedReflectance_TrueColor', 'MODIS_Aqua_CorrectedReflectance_TrueColor'],
				default: 'VIIRS_SNPP_CorrectedReflectance_TrueColor'
			}
		},
		dynamic: { date: yesterday },
		attribution: 'NASA EOSDIS GIBS',
		info: 'Yesterday’s image, 250 m – clouds and water turbidity, not for reef details.'
	},
	{
		id: 'esri',
		resolution: 'up to 0.3 m (varies)',
		dateKind: 'esri',
		name: 'Esri World Imagery',
		kind: 'satellite',
		type: 'xyz',
		url: 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={key}',
		ext: 'jpg',
		maxNativeZoom: 19,
		needsKey: true,
		keyLabel: 'ArcGIS API key',
		keyUrl: 'https://location.arcgis.com/',
		mode: 'live',
		prefetch: false,
		attribution: 'Esri, Vantor, Earthstar Geographics, and the GIS User Community',
		info: 'High resolution (often < 1 m). Free ArcGIS Location Platform account, 2 million tiles/month.'
	},
	{
		id: 'mapbox',
		resolution: 'often < 1 m (varies)',
		dateKind: 'none',
		name: 'Mapbox Satellite',
		kind: 'satellite',
		type: 'xyz',
		url: 'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90?access_token={key}',
		ext: 'jpg',
		maxNativeZoom: 19,
		needsKey: true,
		keyLabel: 'Mapbox access token',
		keyUrl: 'https://account.mapbox.com/',
		mode: 'live',
		prefetch: false,
		attribution: '© Mapbox © Maxar',
		info: 'High resolution. Free tier 750,000 tiles/month.'
	},
	{
		id: 'maptiler',
		resolution: 'often < 1 m (varies)',
		dateKind: 'none',
		name: 'MapTiler Satellite',
		kind: 'satellite',
		type: 'xyz',
		url: 'https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}',
		ext: 'jpg',
		maxNativeZoom: 20,
		needsKey: true,
		keyLabel: 'MapTiler API key',
		keyUrl: 'https://cloud.maptiler.com/account/keys/',
		mode: 'direct',
		prefetch: false,
		attribution: '© MapTiler © OpenStreetMap contributors',
		info: 'High resolution. Free plan for personal use (loaded directly by the browser).'
	},
	{
		id: 'google',
		resolution: 'often < 1 m (varies)',
		dateKind: 'none',
		name: 'Google Satellite',
		kind: 'satellite',
		type: 'google',
		url: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session={session}&key={key}',
		ext: 'jpg',
		maxNativeZoom: 20,
		needsKey: true,
		keyLabel: 'Google Maps Platform API key (Map Tiles API enabled)',
		keyUrl: 'https://console.cloud.google.com/google/maps-apis/',
		mode: 'live',
		prefetch: false,
		attribution: 'Imagery © Google',
		info: 'High resolution. Needs a Google Cloud billing account; daily quota.'
	},
	{
		id: 'emodnet',
		resolution: '~115 m grid',
		name: 'EMODnet Bathymetry',
		kind: 'depth',
		type: 'wms',
		url: 'https://ows.emodnet-bathymetry.eu/wms',
		layers: 'emodnet:mean_multicolour',
		ext: 'png',
		format: 'image/png',
		transparent: true,
		maxNativeZoom: 14,
		mode: 'cache',
		prefetch: true,
		ttlDays: 180,
		attribution: 'EMODnet Bathymetry Consortium',
		info: 'European seas incl. Mediterranean, ~115 m grid.'
	},
	{
		id: 'gebco',
		resolution: '~450 m grid',
		name: 'GEBCO Bathymetry',
		kind: 'depth',
		type: 'wms',
		url: 'https://wms.gebco.net/mapserv',
		layers: 'GEBCO_LATEST_2',
		ext: 'png',
		format: 'image/png',
		maxNativeZoom: 12,
		mode: 'cache',
		prefetch: true,
		ttlDays: 365,
		attribution: 'GEBCO Compilation Group',
		info: 'Worldwide, ~450 m grid – overview only.'
	}
];

export const byId = (id) => PROVIDERS.find((p) => p.id === id);
