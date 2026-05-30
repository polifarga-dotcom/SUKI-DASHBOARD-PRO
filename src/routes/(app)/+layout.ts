import { redirect } from '@sveltejs/kit';
import { supabase } from '$lib/supabase.js';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async () => {
	const {
		data: { session }
	} = await supabase.auth.getSession();

	if (!session) throw redirect(302, '/login');

	const { data: roleData } = await supabase
		.from('user_roles')
		.select('role, force_password_change')
		.eq('user_id', session.user.id)
		.single();

	if (roleData?.force_password_change) throw redirect(302, '/change-password');

	// Load all boats this user is a member of
	const { data: memberships } = await supabase
		.from('boat_members')
		.select('role, boats(*)')
		.eq('user_id', session.user.id);

	const boats = (memberships ?? [])
		.map((m: { role: string; boats: unknown }) => m.boats)
		.filter(Boolean);

	// No boat yet → onboarding (must not be inside (app) layout to avoid redirect loop)
	if (!boats.length) throw redirect(302, '/onboarding');

	return {
		session,
		role:        roleData?.role ?? 'viewer',
		memberships: memberships   ?? [],
	};
};
