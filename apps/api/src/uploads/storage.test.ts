import { Readable } from 'stream';
import os from 'os';
import path from 'path';
import { rmSync } from 'fs';
import { LocalStorage, S3Storage, S3Like } from './storage';

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

describe('LocalStorage', () => {
  const dir = path.join(os.tmpdir(), `convoy-storage-test-${process.pid}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('saves a stream, reads it back with the given content type, then removes it', async () => {
    const store = new LocalStorage(dir);
    await store.save('a1.jpg', Readable.from(Buffer.from('hello')), 'image/jpeg');

    const obj = await store.read('a1.jpg', 'image/jpeg');
    expect(obj).not.toBeNull();
    expect(obj!.contentType).toBe('image/jpeg');
    expect(obj!.contentLength).toBe(5);
    expect(await drain(obj!.stream)).toBe('hello');

    await store.remove('a1.jpg');
    expect(await store.read('a1.jpg', 'image/jpeg')).toBeNull();
  });

  it('read returns null for a missing file', async () => {
    const store = new LocalStorage(dir);
    expect(await store.read('nope.png', 'image/png')).toBeNull();
  });
});

describe('S3Storage', () => {
  function mockClient(sendImpl?: (cmd: { input: Record<string, unknown> }) => Promise<unknown>): S3Like & { send: jest.Mock } {
    const send = jest.fn(sendImpl ?? (async () => ({})));
    return { send } as unknown as S3Like & { send: jest.Mock };
  }

  it('save issues a PutObject with bucket, key, content type and the buffered body', async () => {
    const client = mockClient();
    const store = new S3Storage(client, 'my-bucket');
    await store.save('k1.jpg', Readable.from(Buffer.from('img-bytes')), 'image/jpeg');

    expect(client.send).toHaveBeenCalledTimes(1);
    const cmd = client.send.mock.calls[0][0];
    expect(cmd.input).toMatchObject({ Bucket: 'my-bucket', Key: 'k1.jpg', ContentType: 'image/jpeg' });
    expect(Buffer.from(cmd.input.Body).toString('utf8')).toBe('img-bytes');
  });

  it('read returns the object body and metadata from GetObject', async () => {
    const client = mockClient(async () => ({
      Body: Readable.from(Buffer.from('stored')),
      ContentType: 'audio/m4a',
      ContentLength: 6,
    }));
    const store = new S3Storage(client, 'my-bucket');
    const obj = await store.read('k2.m4a', 'application/octet-stream');
    expect(obj).not.toBeNull();
    expect(obj!.contentType).toBe('audio/m4a');
    expect(obj!.contentLength).toBe(6);
    expect(await drain(obj!.stream)).toBe('stored');
  });

  it('read returns null when the key does not exist (NoSuchKey)', async () => {
    const client = mockClient(async () => { throw Object.assign(new Error('missing'), { name: 'NoSuchKey' }); });
    const store = new S3Storage(client, 'my-bucket');
    expect(await store.read('gone.jpg', 'image/jpeg')).toBeNull();
  });

  it('remove issues a DeleteObject and swallows failures', async () => {
    const client = mockClient();
    const store = new S3Storage(client, 'my-bucket');
    await store.remove('k3.jpg');
    const cmd = client.send.mock.calls[0][0];
    expect(cmd.input).toMatchObject({ Bucket: 'my-bucket', Key: 'k3.jpg' });
  });
});
