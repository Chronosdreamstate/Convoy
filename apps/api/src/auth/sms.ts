import { env } from '../config/env';

/**
 * SMS delivery for phone-OTP sign-in.
 *
 * The app implements its own OTP (Redis-stored, verified server-side); this
 * module is the delivery seam. Twilio is the default provider (dependency-free
 * REST call). To use a different provider (or Firebase Phone Auth, per the
 * original design doc), swap the 'twilio' branch — the OTP flow and the
 * production config guard (env.productionConfigErrors) stay the same.
 */

export interface SmsConfig {
  provider: 'twilio' | 'none';
  twilioSid: string;
  twilioToken: string;
  twilioFrom: string;
}

function configFromEnv(): SmsConfig {
  return {
    provider: env.SMS_PROVIDER,
    twilioSid: env.TWILIO_ACCOUNT_SID,
    twilioToken: env.TWILIO_AUTH_TOKEN,
    twilioFrom: env.TWILIO_FROM_NUMBER,
  };
}

/**
 * Send an SMS. Throws if the provider is unconfigured or the send fails so the
 * caller can surface a real error instead of pretending the code was sent.
 * `fetchImpl` is injectable for tests.
 */
export async function sendSms(
  to: string,
  body: string,
  config: SmsConfig = configFromEnv(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (config.provider === 'twilio') {
    if (!config.twilioSid || !config.twilioToken || !config.twilioFrom) {
      throw new Error('Twilio is not fully configured');
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`;
    const auth = Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64');
    const params = new URLSearchParams({ To: to, From: config.twilioFrom, Body: body });

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Twilio send failed: ${res.status} ${detail}`);
    }
    return;
  }

  throw new Error('SMS provider not configured');
}

/** Deliver a phone-OTP code via the configured SMS provider. */
export async function sendOtpSms(
  phone: string,
  otp: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await sendSms(
    phone,
    `Your CONVOY verification code is ${otp}. It expires in 5 minutes.`,
    configFromEnv(),
    fetchImpl,
  );
}
