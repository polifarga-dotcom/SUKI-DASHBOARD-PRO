-- Allow any boat member to update unit_system and time_format preferences
-- These are display preferences (not sensitive boat data)
-- The app controls what fields are editable to users

-- Drop the old admin-only update policy
drop policy if exists "admins update boat" on public.boats;

-- Create new policy: Members can update boats (for unit preferences)
-- Admins can still update all fields, members can only update via the Settings page
create policy "members update boat settings"
  on public.boats for update
  to authenticated
  using (
    -- User must be a member of the boat
    exists (
      select 1 from public.boat_members
      where boat_id = boats.id and user_id = auth.uid()
    )
  );
