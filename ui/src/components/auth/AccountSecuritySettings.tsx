import { LockKeyhole } from "lucide-react";
import { PasskeySettings } from "./PasskeySettings";
import { TwoFactorSettings } from "./TwoFactorSettings";

export function AccountSecuritySettings() {
  return (
    <section className="space-y-6" aria-label="Sign-in security">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <LockKeyhole className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Sign-in security</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Add a second step to password sign-in, or sign in with a passkey.
        </p>
      </div>
      <TwoFactorSettings />
      <PasskeySettings />
    </section>
  );
}
