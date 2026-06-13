import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const slug = params.slug;
	const manifest = {
		name: 'SUKI · Live Tracker',
		short_name: 'SUKI Tracker',
		description: 'Live boat position and weather tracker',
		start_url: `/track/${slug}`,
		display: 'standalone',
		background_color: '#080c14',
		theme_color: '#080c14',
		orientation: 'portrait-primary',
		icons: [
			{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
			{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
			{ src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
		],
	};
	return new Response(JSON.stringify(manifest), {
		headers: {
			'Content-Type': 'application/manifest+json',
			'Cache-Control': 'public, max-age=3600',
		},
	});
};
