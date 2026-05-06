import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

// Root: authenticated operators go straight to /launch (which mints the Caddy
// JWT and redirects to app.ops.binelek.io). Everyone else goes to /login.
export default async function RootPage() {
  const session = await auth();
  if (session?.user != null) {
    redirect('/launch');
  }
  redirect('/login');
}
