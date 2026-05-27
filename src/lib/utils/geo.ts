const R = 6371000; // Earth radius metres

export function haversine(
	lat1: number, lon1: number,
	lat2: number, lon2: number
): number {
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) *
		Math.cos((lat2 * Math.PI) / 180) *
		Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearingTo(
	lat1: number, lon1: number,
	lat2: number, lon2: number
): number {
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
	const x =
		Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
		Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(dLon);
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function destinationPoint(
	lat: number, lon: number,
	bearingDeg: number, distM: number
): [number, number] {
	const brng = (bearingDeg * Math.PI) / 180;
	const d = distM / R;
	const lat1 = (lat * Math.PI) / 180;
	const lon1 = (lon * Math.PI) / 180;
	const lat2 = Math.asin(
		Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
	);
	const lon2 =
		lon1 +
		Math.atan2(
			Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
			Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
		);
	return [(lat2 * 180) / Math.PI, ((lon2 * 180) / Math.PI + 540) % 360 - 180];
}
