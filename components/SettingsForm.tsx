'use client';

import { useActionState, useState } from 'react';
import { loginAction, saveSettingsAction, testAlertAction, type FormState } from '@/app/settings/actions';
import type { Settings } from '@/lib/types';

const input = 'card w-full px-3 py-2.5 text-sm';
const button = 'primary-button disabled:opacity-50';
const secondary = 'secondary-button disabled:opacity-50';

function Result({ state }: { state: FormState }) {
  if (state.error) return <p role="alert" className="text-sm text-critical">{state.error}</p>;
  if (state.ok) return <p role="status" className="text-sm text-good-ink">{state.ok}</p>;
  return null;
}

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, {});
  return (
    <form action={action} className="card flex max-w-sm flex-col gap-3 p-4">
      <label className="text-sm font-medium" htmlFor="token">Admin token</label>
      <input id="token" name="token" type="password" autoComplete="current-password" required className={input} />
      <button disabled={pending} className={button}>Sign in</button>
      <Result state={state} />
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-2">{hint}</span>}
    </label>
  );
}

export function SettingsForm({ settings, emailReady }: { settings: Settings; emailReady: boolean }) {
  const [state, action, pending] = useActionState(saveSettingsAction, {});
  const [test, testAction, testing] = useActionState(testAlertAction, {});
  const [threshold, setThreshold] = useState(settings.thresholdPeople);
  const [ppc, setPpc] = useState(settings.peoplePerCustomer);

  return (
    <div className="flex flex-col gap-6">
      <form action={action} className="flex flex-col gap-6">
        <section className="card flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold">Alert noise</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Alert level, in estimated people" hint={`About ${Math.round(threshold / ppc).toLocaleString('en-US')} customers in one metro.`}>
              <input name="thresholdPeople" type="number" min={500} step={500} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className={input} />
            </Field>
            <Field label="People per customer" hint="Customers are meters, mostly households. US average is about 2.5.">
              <input name="peoplePerCustomer" type="number" min={1} max={5} step={0.1} value={ppc} onChange={(e) => setPpc(Number(e.target.value))} className={input} />
            </Field>
            <Field label="Polls over the level before alerting" hint="Each poll is 5 minutes. Higher ignores short blips.">
              <input name="confirmPolls" type="number" min={1} max={12} defaultValue={settings.confirmPolls} className={input} />
            </Field>
            <Field label="Polls recovered before resolving" hint="An alert resolves below half the alert level.">
              <input name="clearPolls" type="number" min={1} max={48} defaultValue={settings.clearPolls} className={input} />
            </Field>
            <Field label="Re-alert when an outage grows by" hint="2 means notify again each time it doubles.">
              <input name="escalateFactor" type="number" min={1.25} max={10} step={0.25} defaultValue={settings.escalateFactor} className={input} />
            </Field>
            <Field label="Sudden jump that alerts, in customers" hint={`Sends a high-priority alert when this many customers go out within 30 minutes and nothing explains it, or three times this at any speed. 0 turns it off.`}>
              <input name="unexplainedCustomers" type="number" min={0} step={1000} defaultValue={settings.unexplainedCustomers} className={input} />
            </Field>
            <Field label="Simultaneous outage, unrelated areas" hint="High-priority alert when this many areas start within 30 minutes with no ordinary cause. 0 turns it off.">
              <input name="simultaneousAreas" type="number" min={0} max={20} defaultValue={settings.simultaneousAreas} className={input} />
            </Field>
            <Field label="Simultaneous outage, customers per area" hint="Each area must reach this. Lower levels start to coincide by chance.">
              <input name="simultaneousCustomers" type="number" min={1000} step={500} defaultValue={settings.simultaneousCustomers} className={input} />
            </Field>
            <Field label="Only these states" hint="Two-letter codes, comma separated. Blank means everywhere.">
              <input name="states" type="text" defaultValue={settings.states.join(', ')} className={input} />
            </Field>
          </div>
        </section>

        <section className="card flex flex-col gap-4 p-4">
          <h2 className="text-sm font-semibold">Where alerts go</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Webhook URL" hint="Slack, Discord, ntfy.sh, or any HTTPS endpoint taking JSON.">
              <input name="webhookUrl" type="url" defaultValue={settings.webhookUrl ?? ''} placeholder="https://" className={input} />
            </Field>
            <Field label="Email" hint={emailReady ? 'Sent through Resend.' : 'Needs the Resend integration, which is not connected yet.'}>
              <input name="emailTo" type="email" defaultValue={settings.emailTo ?? ''} disabled={!emailReady} className={input} />
            </Field>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <button disabled={pending} className={button}>Save settings</button>
          <Result state={state} />
        </div>
      </form>

      <form action={testAction} className="flex items-center gap-3">
        <button disabled={testing} className={secondary}>Send a test alert</button>
        <Result state={test} />
      </form>
    </div>
  );
}
