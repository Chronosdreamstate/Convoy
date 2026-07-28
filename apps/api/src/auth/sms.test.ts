import { sendSms, SmsConfig } from './sms';

const twilio: SmsConfig = {
  provider: 'twilio',
  twilioSid: 'AC123',
  twilioToken: 'secret',
  twilioFrom: '+15550001111',
};

function mockFetch(response: { ok: boolean; status?: number; text?: string }) {
  return jest.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    text: async () => response.text ?? '',
  }) as unknown as typeof fetch;
}

describe('sendSms (twilio)', () => {
  it('POSTs to the Twilio Messages API with basic auth and the message body', async () => {
    const fetchImpl = mockFetch({ ok: true });
    await sendSms('+15557778888', 'hello', twilio, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:secret').toString('base64')}`);
    const body = new URLSearchParams(init.body as string);
    expect(body.get('To')).toBe('+15557778888');
    expect(body.get('From')).toBe('+15550001111');
    expect(body.get('Body')).toBe('hello');
  });

  it('throws when Twilio returns a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, text: 'unauthorized' });
    await expect(sendSms('+15557778888', 'hi', twilio, fetchImpl)).rejects.toThrow(/Twilio send failed: 401/);
  });

  it('throws when Twilio is selected but not fully configured', async () => {
    const fetchImpl = mockFetch({ ok: true });
    await expect(
      sendSms('+1555', 'hi', { ...twilio, twilioToken: '' }, fetchImpl),
    ).rejects.toThrow(/not fully configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when no SMS provider is configured', async () => {
    const fetchImpl = mockFetch({ ok: true });
    await expect(
      sendSms('+1555', 'hi', { provider: 'none', twilioSid: '', twilioToken: '', twilioFrom: '' }, fetchImpl),
    ).rejects.toThrow(/not configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
