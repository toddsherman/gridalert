import type { Metadata } from 'next';
import { LoginForm, SettingsForm } from '@/components/SettingsForm';
import { isAdmin } from '@/lib/auth';
import { getSettings } from '@/lib/run';
import { logoutAction } from './actions';

export const metadata: Metadata = { title: 'Settings | GridAlert' };

export default async function SettingsPage() {
  const admin = await isAdmin();
  if (!admin) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-serif text-2xl font-semibold tracking-tight">Settings</h1>
        <LoginForm />
      </div>
    );
  }
  const settings = await getSettings(true);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold tracking-tight">Settings</h1>
        <form action={logoutAction}>
          <button className="text-sm text-ink-2 hover:underline">Sign out</button>
        </form>
      </div>
      <SettingsForm settings={settings} emailReady={Boolean(process.env.RESEND_API_KEY)} />
    </div>
  );
}
