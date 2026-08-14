// tests/unit/adapters-media-llm.test.js — U2-MEDIA-LLM unit/integration tests.
//
// Verifies (SRS Appendix B traceability):
//   FR-02/FR-03/FR-05 — media stored by key in object storage and referenced from
//                       media_objects rows (ADR-004 attach/list path)
//   NFR-12 (ST-05)    — deleteByKey removes exactly one object and a later get 404s;
//                       mediaService.deleteForUser calls deleteByKey per owned key and
//                       removes the rows (the account-erasure media hook)
//   NFR-09 (RT-01)    — object-storage and LLM calls run under withResilience: bounded
//                       retries, timeout, typed degraded-mode errors (placeholder rendering
//                       for media; pending-forever for moderation per ADR-002)
//   FR-08 / NFR-10    — llmModeration.classify(text) -> {category, confidence, model};
//                       NODE_ENV=test resolves the deterministic mock (ADR-007); no
//                       provider name, model id or key literal in adapter source
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../../src/config');
const db = require('../helpers/db');
const objectStorage = require('../../src/adapters/objectStorage');
const mediaService = require('../../src/modules/media/service');
const llm = require('../../src/adapters/llmModeration');
const llmMock = require('../../src/adapters/llmModeration.mock');

const { createObjectStorage, ObjectStorageUnavailableError } = objectStorage;

// Unique per-run key prefix so concurrent/repeated runs never collide in MinIO.
const KEY_PREFIX = `test/u2mll/${process.pid}-${Date.now()}`;
let keySeq = 0;
function nextKey(label = 'obj') {
  keySeq += 1;
  return `${KEY_PREFIX}/${label}-${keySeq}.bin`;
}

// Keys that may still exist in MinIO at the end of the run (best-effort cleanup).
const cleanupKeys = new Set();

async function putTracked(key, body, opts) {
  cleanupKeys.add(key);
  return objectStorage.put(key, body, opts);
}

afterAll(async () => {
  for (const key of cleanupKeys) {
    try {
      await objectStorage.deleteByKey(key);
    } catch (_err) {
      // best-effort cleanup only
    }
  }
  await db.query(`DELETE FROM media_objects WHERE storage_key LIKE $1`, [`test/u2mll/%`]);
  objectStorage.destroy();
  await db.closeDb();
});

afterEach(() => {
  llmMock.reset();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Object-storage adapter (ADR-004, NFR-09, NFR-12)
// ---------------------------------------------------------------------------------------------
describe('objectStorage adapter (ADR-004)', () => {
  test('put stores an object and get returns the same bytes and content type', async () => {
    const key = nextKey('roundtrip');
    const body = Buffer.from('homeplate-media-roundtrip-payload');

    const stored = await putTracked(key, body, { contentType: 'image/jpeg' });
    expect(stored.key).toBe(key);
    expect(stored.sizeBytes).toBe(body.length);

    const fetched = await objectStorage.get(key);
    expect(Buffer.compare(fetched.body, body)).toBe(0);
    expect(fetched.contentType).toBe('image/jpeg');
    expect(fetched.contentLength).toBe(body.length);
  });

  test('deleteByKey removes exactly one object and a subsequent get 404s (NFR-12)', async () => {
    const keyA = nextKey('delete-a');
    const keyB = nextKey('delete-b');
    await putTracked(keyA, 'object A');
    await putTracked(keyB, 'object B');

    const result = await objectStorage.deleteByKey(keyA);
    expect(result).toEqual({ key: keyA, deleted: true });

    // The deleted object is gone: get rejects with a typed 404.
    await expect(objectStorage.get(keyA)).rejects.toMatchObject({
      status: 404,
      code: 'MEDIA_NOT_FOUND',
      retryable: false,
    });
    // Exactly ONE object was removed: the sibling is untouched.
    const other = await objectStorage.get(keyB);
    expect(other.body.toString()).toBe('object B');
  });

  test('deleteByKey is idempotent so a retried erasure job is safe (NFR-12)', async () => {
    const key = nextKey('idempotent');
    await putTracked(key, 'x');
    await objectStorage.deleteByKey(key);
    await expect(objectStorage.deleteByKey(key)).resolves.toEqual({ key, deleted: true });
  });

  test('get on a key that never existed rejects with the typed 404', async () => {
    await expect(objectStorage.get(`${KEY_PREFIX}/never-existed.bin`)).rejects.toMatchObject({
      status: 404,
      code: 'MEDIA_NOT_FOUND',
    });
  });

  test('invalid keys are rejected before any network call (NFR-11)', async () => {
    const badKeys = [
      '',
      '/leading-slash',
      'a/../traversal',
      'spaces are bad',
      '.hidden',
      123,
      null,
    ];
    for (const bad of badKeys) {
      await expect(objectStorage.get(bad)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
      await expect(objectStorage.deleteByKey(bad)).rejects.toMatchObject({
        code: 'INVALID_STORAGE_KEY',
      });
      await expect(objectStorage.put(bad, 'x')).rejects.toMatchObject({
        code: 'INVALID_STORAGE_KEY',
      });
    }
  });

  test('a storage outage yields the typed retryable error after bounded retries (NFR-09)', async () => {
    let calls = 0;
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), {
      code: 'ECONNREFUSED',
    });
    const outageClient = {
      async send() {
        calls += 1;
        throw refused;
      },
    };
    const adapter = createObjectStorage({
      client: outageClient,
      retries: 1,
      timeoutMs: 500,
      backoff: { baseMs: 1 },
    });

    const failure = await adapter.get('some/key.bin').catch((err) => err);
    // Typed degraded-mode error the caller can render as a placeholder (NFR-09).
    expect(failure).toBeInstanceOf(ObjectStorageUnavailableError);
    expect(failure).toMatchObject({
      status: 503,
      code: 'OBJECT_STORAGE_UNAVAILABLE',
      retryable: true,
    });
    // Bounded retries via withResilience: first attempt + exactly one retry.
    expect(calls).toBe(2);

    await expect(adapter.put('some/key.bin', 'x')).rejects.toMatchObject({
      code: 'OBJECT_STORAGE_UNAVAILABLE',
    });
    await expect(adapter.deleteByKey('some/key.bin')).rejects.toMatchObject({
      code: 'OBJECT_STORAGE_UNAVAILABLE',
    });
  });

  test('a hung store times out through withResilience (NFR-09 per-attempt budget)', async () => {
    const hangingClient = {
      send(_cmd, opts) {
        return new Promise((_resolve, reject) => {
          opts.abortSignal.addEventListener('abort', () => reject(opts.abortSignal.reason));
        });
      },
    };
    const adapter = createObjectStorage({
      client: hangingClient,
      retries: 0,
      timeoutMs: 50,
      backoff: { baseMs: 1 },
    });
    await expect(adapter.get('slow/key.bin')).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      retryable: true,
    });
  });

  test('misconfiguration (access denied) is typed and NOT retried', async () => {
    let calls = 0;
    const deniedClient = {
      async send() {
        calls += 1;
        const err = new Error('Access Denied');
        err.name = 'AccessDenied';
        err.$metadata = { httpStatusCode: 403 };
        throw err;
      },
    };
    const adapter = createObjectStorage({
      client: deniedClient,
      retries: 2,
      timeoutMs: 500,
      backoff: { baseMs: 1 },
    });
    await expect(adapter.get('some/key.bin')).rejects.toMatchObject({
      code: 'OBJECT_STORAGE_REJECTED',
      retryable: false,
    });
    expect(calls).toBe(1); // non-retryable faults stop immediately
  });
});

// ---------------------------------------------------------------------------------------------
// Media service (FR-02/03/05 attach/list; NFR-12 deleteForUser)
// ---------------------------------------------------------------------------------------------
describe('mediaService (ADR-004 / NFR-12)', () => {
  test('attach records a media_objects row owned by the user (FR-02/03/05)', async () => {
    const user = await db.makeUser();
    const key = nextKey('attach');

    const row = await mediaService.attach(user.id, key, 'listing', {
      contentType: 'image/png',
      sizeBytes: 2048,
    });
    expect(row).toMatchObject({
      ownerUserId: user.id,
      storageKey: key,
      entityType: 'listing',
      contentType: 'image/png',
      sizeBytes: 2048,
      deletedAt: null,
    });
    expect(row.id).toEqual(expect.any(String));

    const { rows } = await db.query(`SELECT * FROM media_objects WHERE storage_key = $1`, [key]);
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_user_id).toBe(user.id);
    expect(rows[0].entity_type).toBe('listing');
  });

  test('attach validates userId, key, and kind at the boundary (NFR-11)', async () => {
    const user = await db.makeUser();
    await expect(mediaService.attach('not-a-uuid', nextKey(), 'listing')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
    await expect(mediaService.attach(user.id, '../etc/passwd', 'listing')).rejects.toMatchObject({
      code: 'INVALID_STORAGE_KEY',
    });
    await expect(mediaService.attach(user.id, nextKey(), 'avatar')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  test('attach maps duplicate keys to 409 and unknown owners to 404', async () => {
    const user = await db.makeUser();
    const key = nextKey('dup');
    await mediaService.attach(user.id, key, 'review');
    await expect(mediaService.attach(user.id, key, 'review')).rejects.toMatchObject({
      status: 409,
      code: 'MEDIA_KEY_EXISTS',
    });
    await expect(
      mediaService.attach('00000000-0000-4000-8000-000000000000', nextKey(), 'listing')
    ).rejects.toMatchObject({ status: 404, code: 'MEDIA_OWNER_NOT_FOUND' });
  });

  test('list returns only the owner’s media, oldest first', async () => {
    const alice = await db.makeUser();
    const bob = await db.makeUser();
    const k1 = nextKey('alice');
    const k2 = nextKey('alice');
    const k3 = nextKey('bob');
    await mediaService.attach(alice.id, k1, 'listing');
    await mediaService.attach(alice.id, k2, 'host_profile');
    await mediaService.attach(bob.id, k3, 'review');

    const aliceMedia = await mediaService.list(alice.id);
    expect(aliceMedia.map((m) => m.storageKey)).toEqual([k1, k2]);
    await expect(mediaService.listKeys(alice.id)).resolves.toEqual([k1, k2]);
    await expect(mediaService.listKeys(bob.id)).resolves.toEqual([k3]);
  });

  test('deleteForUser calls deleteByKey per owned key, removes the rows, and the objects 404 after (NFR-12)', async () => {
    const doomed = await db.makeUser();
    const bystander = await db.makeUser();

    const doomedKeys = [nextKey('erase'), nextKey('erase'), nextKey('erase')];
    for (const key of doomedKeys) {
      await putTracked(key, `content of ${key}`);
      await mediaService.attach(doomed.id, key, 'listing');
    }
    const keptKey = nextKey('kept');
    await putTracked(keptKey, 'bystander content');
    await mediaService.attach(bystander.id, keptKey, 'review');

    const deleteSpy = jest.spyOn(objectStorage, 'deleteByKey'); // calls through to MinIO

    const result = await mediaService.deleteForUser(doomed.id);
    expect(result).toEqual({ deletedObjects: 3, deletedRows: 3, total: 3 });

    // The NFR-12 hook: exactly one deleteByKey call per owned key, no more, no fewer.
    expect(deleteSpy).toHaveBeenCalledTimes(3);
    expect(deleteSpy.mock.calls.map((call) => call[0]).sort()).toEqual([...doomedKeys].sort());

    // Rows are gone for the erased user, retained for everyone else.
    const { rows: doomedRows } = await db.query(
      `SELECT * FROM media_objects WHERE owner_user_id = $1`,
      [doomed.id]
    );
    expect(doomedRows).toHaveLength(0);
    await expect(mediaService.listKeys(bystander.id)).resolves.toEqual([keptKey]);

    // The objects are truly gone from storage: every subsequent get 404s (ADR-004).
    for (const key of doomedKeys) {
      await expect(objectStorage.get(key)).rejects.toMatchObject({
        status: 404,
        code: 'MEDIA_NOT_FOUND',
      });
    }
    // The bystander's object is untouched.
    await expect(objectStorage.get(keptKey)).resolves.toMatchObject({ key: keptKey });
  });

  test('deleteForUser with no owned media resolves to zero and never touches storage', async () => {
    const user = await db.makeUser();
    const deleteSpy = jest.spyOn(objectStorage, 'deleteByKey');
    await expect(mediaService.deleteForUser(user.id)).resolves.toEqual({
      deletedObjects: 0,
      deletedRows: 0,
      total: 0,
    });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test('a partial storage failure keeps the failed rows and raises a retryable error (NFR-09/NFR-12)', async () => {
    const user = await db.makeUser();
    const okKey = nextKey('partial-ok');
    const badKey = nextKey('partial-bad');
    cleanupKeys.add(okKey);
    cleanupKeys.add(badKey);
    await mediaService.attach(user.id, okKey, 'listing');
    await mediaService.attach(user.id, badKey, 'listing');

    jest.spyOn(objectStorage, 'deleteByKey').mockImplementation(async (key) => {
      if (key === badKey) throw new ObjectStorageUnavailableError('simulated outage');
      return { key, deleted: true };
    });

    const failure = await mediaService.deleteForUser(user.id).catch((err) => err);
    expect(failure).toMatchObject({
      code: 'MEDIA_ERASURE_INCOMPLETE',
      retryable: true,
      details: { failedCount: 1, totalCount: 2 },
    });

    // The failed key's row survives so a retried job can finish the erasure.
    await expect(mediaService.listKeys(user.id)).resolves.toEqual([badKey]);
  });
});

// ---------------------------------------------------------------------------------------------
// Moderation LLM adapter (FR-08, ADR-002/007, NFR-09, NFR-10)
// ---------------------------------------------------------------------------------------------
describe('llmModeration adapter (ADR-007)', () => {
  test('NODE_ENV=test resolves the deterministic mock adapter', async () => {
    expect(config.env).toBe('test');
    expect(config.moderation.mode).toBe('mock');
    expect(llm.mode).toBe('mock');
    expect(llm.model).toBe(llmMock.model);

    // Forcing an outage on the mock module changes llm.classify behaviour — proof that the
    // resolved adapter IS the shared mock instance, not a copy.
    llmMock.setOutage(true);
    await expect(llm.classify('any text at all')).rejects.toBeInstanceOf(
      llm.ModerationProviderError
    );
    llmMock.reset();
    await expect(llm.classify('any text at all')).resolves.toMatchObject({ category: 'benign' });
  });

  test('the mock is deterministic: fixed fixture mapping text patterns -> {category, confidence}', async () => {
    const cases = [
      ['you are an idiot and I hate you', 'offensive', 0.97],
      ['CLICK HERE for FREE MONEY, buy now!!!', 'spam', 0.95],
      ['send me a wire transfer or a gift card first', 'fraudulent', 0.93],
      ['Homemade tamales this Saturday, 6 seats at my table', 'benign', 0.99],
    ];
    for (const [text, category, confidence] of cases) {
      const first = await llm.classify(text);
      const second = await llm.classify(text);
      expect(first).toEqual({ category, confidence, model: llmMock.model });
      expect(second).toEqual(first); // same input, same output — deterministic
      expect(llm.CATEGORIES).toContain(first.category);
    }
  });

  test('the low-confidence sentinel lands below the FR-08 routing threshold', async () => {
    const result = await llm.classify(`${llmMock.LOW_CONFIDENCE_SENTINEL} borderline text`);
    expect(result.confidence).toBeLessThan(config.moderation.confidenceThreshold);
  });

  test('a provider failure surfaces as a typed retryable error (ADR-002: content stays pending)', async () => {
    const failure = await llm
      .classify(`${llmMock.OUTAGE_SENTINEL} listing text`)
      .catch((err) => err);
    expect(failure).toBeInstanceOf(llm.ModerationProviderError);
    expect(failure).toMatchObject({
      status: 503,
      code: 'MODERATION_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  test('classify validates its input', async () => {
    await expect(llm.classify('')).rejects.toBeInstanceOf(TypeError);
    await expect(llm.classify('   ')).rejects.toBeInstanceOf(TypeError);
    await expect(llm.classify(123)).rejects.toBeInstanceOf(TypeError);
  });

  describe('live adapter over an injected transport', () => {
    const LIVE_OPTS = {
      baseUrl: 'https://moderation.example.test',
      apiKey: 'test-api-key-123',
      model: 'test-model-9',
      retries: 1,
      timeoutMs: 500,
      backoff: { baseMs: 1 },
    };

    function jsonResponse(status, bodyObj) {
      return {
        status,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify(bodyObj),
      };
    }

    function makeFetch(...responses) {
      const calls = [];
      const impl = async (url, init) => {
        calls.push({ url, init });
        const next = responses[Math.min(calls.length - 1, responses.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      };
      impl.calls = calls;
      return impl;
    }

    test('POSTs to the configured base URL with model and key from config, returns {category, confidence, model}', async () => {
      const fetchImpl = makeFetch(
        jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: '{"category":"spam","confidence":0.91}' }] } }],
        })
      );
      const adapter = llm.createLiveLlmModerationAdapter({ ...LIVE_OPTS, fetchImpl });

      const result = await adapter.classify('BUY NOW cheap meal promotion');
      expect(result).toEqual({ category: 'spam', confidence: 0.91, model: 'test-model-9' });

      expect(fetchImpl.calls).toHaveLength(1);
      const { url, init } = fetchImpl.calls[0];
      // Connection facts come from configuration, not source literals (ADR-007).
      expect(url.startsWith('https://moderation.example.test/')).toBe(true);
      expect(url).toContain('test-model-9');
      expect(url).toContain('key=test-api-key-123');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      const prompt = body.contents[0].parts[0].text;
      expect(prompt).toContain('BUY NOW cheap meal promotion');
      expect(prompt).toContain('"category"'); // embedded safety policy demands strict JSON
      expect(body.generationConfig.temperature).toBe(0);
    });

    test('unwraps a fenced JSON classification', async () => {
      const fetchImpl = makeFetch(
        jsonResponse(200, {
          candidates: [
            {
              content: {
                parts: [{ text: '```json\n{"category":"offensive","confidence":0.88}\n```' }],
              },
            },
          ],
        })
      );
      const adapter = llm.createLiveLlmModerationAdapter({ ...LIVE_OPTS, fetchImpl });
      await expect(adapter.classify('some text')).resolves.toEqual({
        category: 'offensive',
        confidence: 0.88,
        model: 'test-model-9',
      });
    });

    test('a 5xx provider failure is retried within bounds, then surfaces as the typed retryable error', async () => {
      const fetchImpl = makeFetch(jsonResponse(500, { error: 'boom' }));
      const adapter = llm.createLiveLlmModerationAdapter({ ...LIVE_OPTS, fetchImpl });

      const failure = await adapter.classify('some text').catch((err) => err);
      expect(failure).toBeInstanceOf(llm.ModerationProviderError);
      expect(failure).toMatchObject({
        code: 'MODERATION_PROVIDER_UNAVAILABLE',
        retryable: true,
      });
      expect(fetchImpl.calls).toHaveLength(2); // first attempt + exactly one retry (bounded)
    });

    test('a rejected credential (401) is typed but NOT retryable, and is not retried', async () => {
      const fetchImpl = makeFetch(jsonResponse(401, { error: 'bad key' }));
      const adapter = llm.createLiveLlmModerationAdapter({ ...LIVE_OPTS, fetchImpl });

      const failure = await adapter.classify('some text').catch((err) => err);
      expect(failure).toBeInstanceOf(llm.ModerationProviderError);
      expect(failure.retryable).toBe(false);
      expect(fetchImpl.calls).toHaveLength(1);
    });

    test('unusable provider output surfaces as the typed retryable error (never a silent approval)', async () => {
      const unusable = [
        { candidates: [] },
        { candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] },
        {
          candidates: [{ content: { parts: [{ text: '{"category":"weird","confidence":0.9}' }] } }],
        },
        {
          candidates: [
            { content: { parts: [{ text: '{"category":"benign","confidence":1.7}' }] } },
          ],
        },
        { candidates: [{ content: { parts: [{ text: '{"category":"benign"}' }] } }] },
      ];
      for (const payload of unusable) {
        const fetchImpl = makeFetch(jsonResponse(200, payload));
        const adapter = llm.createLiveLlmModerationAdapter({ ...LIVE_OPTS, fetchImpl });
        const failure = await adapter.classify('some text').catch((err) => err);
        expect(failure).toBeInstanceOf(llm.ModerationProviderError);
        expect(failure.retryable).toBe(true);
      }
    });

    test('live mode without the three env-provided connection facts fails fast', () => {
      expect(() => llm.createLiveLlmModerationAdapter({ apiKey: 'k', model: 'm' })).toThrow(
        /LLM_MODERATION_BASE_URL/
      );
    });
  });

  test('no provider name, model id, or key literal appears in adapter source (ADR-007)', () => {
    const adapterDir = path.join(__dirname, '..', '..', 'src', 'adapters');
    const sources = ['llmModeration.js', 'llmModeration.mock.js'].map((file) =>
      fs.readFileSync(path.join(adapterDir, file), 'utf8')
    );
    // Provider names and provider-branded hosts/headers/models that must never be hardcoded.
    const forbiddenSubstrings = [
      'gemini',
      'google',
      'googleapis',
      'generativelanguage',
      'x-goog',
      'aistudio',
      'makersuite',
      'vertex',
      'openai',
      'gpt-',
      'anthropic',
      'claude',
      'mistral',
      'cohere',
    ];
    // Credential-shaped literals.
    const forbiddenPatterns = [/AIza[0-9A-Za-z_-]{10,}/, /sk-[A-Za-z0-9]{20,}/];

    for (const source of sources) {
      const lower = source.toLowerCase();
      for (const banned of forbiddenSubstrings) {
        expect(lower.includes(banned)).toBe(false);
      }
      for (const pattern of forbiddenPatterns) {
        expect(pattern.test(source)).toBe(false);
      }
    }
  });
});
