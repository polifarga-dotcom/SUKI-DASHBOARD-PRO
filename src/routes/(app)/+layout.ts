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

	return { session, role: roleData?.role ?? 'viewer' };
};
