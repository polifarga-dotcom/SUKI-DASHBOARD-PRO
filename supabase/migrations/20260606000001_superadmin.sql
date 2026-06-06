-- Add is_superadmin flag to user_roles
ALTER TABLE public.user_roles ADD COLUMN is_superadmin BOOLEAN NOT NULL DEFAULT false;

-- Grant superadmin to polifarga@gmail.com
UPDATE public.user_roles
SET is_superadmin = true
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'polifarga@gmail.com');
