import { redirect } from '@sveltejs/kit';
import { supabase } from '$lib/supabase.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
	const {
		data: { session }
	} = await supabase.auth.getSession();
	if (!session) throw redirect(302, '/login');

	const { data: roleData } = await supabase
		.from('user_roles')
		.select('force_password_change')
		.eq('user_id', session.user.id)
		.single();

	if (!roleData?.force_password_change) throw redirect(302, '/vessel');

	return {};
};
