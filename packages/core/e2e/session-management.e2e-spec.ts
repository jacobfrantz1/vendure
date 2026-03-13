/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { CachedSession, mergeConfig, SessionCacheStrategy } from '@vendure/core';
import { createTestEnvironment, SimpleGraphQLClient } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { SUPER_ADMIN_USER_IDENTIFIER, SUPER_ADMIN_USER_PASSWORD } from '../../common/src/shared-constants';

import {
    attemptLoginDocument,
    logoutDocument,
    logoutEverywhereDocument,
    MeDocument,
} from './graphql/shared-definitions';

const testSessionCache = new Map<string, CachedSession>();
const getSpy = vi.fn();
const setSpy = vi.fn();
const clearSpy = vi.fn();
const deleteSpy = vi.fn();

class TestingSessionCacheStrategy implements SessionCacheStrategy {
    clear() {
        clearSpy();
        testSessionCache.clear();
    }

    delete(sessionToken: string) {
        deleteSpy(sessionToken);
        testSessionCache.delete(sessionToken);
    }

    get(sessionToken: string) {
        getSpy(sessionToken);
        return testSessionCache.get(sessionToken);
    }

    set(session: CachedSession) {
        setSpy(session);
        testSessionCache.set(session.token, session);
    }
}

describe('Session caching', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            authOptions: {
                sessionCacheStrategy: new TestingSessionCacheStrategy(),
                sessionCacheTTL: 2,
            },
        }),
    );

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 1,
        });
        testSessionCache.clear();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('populates the cache on login', async () => {
        setSpy.mockClear();
        expect(setSpy.mock.calls.length).toBe(0);
        expect(testSessionCache.size).toBe(0);

        await adminClient.query(attemptLoginDocument, {
            username: SUPER_ADMIN_USER_IDENTIFIER,
            password: SUPER_ADMIN_USER_PASSWORD,
        });

        expect(testSessionCache.size).toBe(1);
        expect(setSpy.mock.calls.length).toBe(1);
    });

    it('takes user data from cache on next request', async () => {
        getSpy.mockClear();
        const { me } = await adminClient.query(MeDocument);

        expect(getSpy.mock.calls.length).toBe(1);
    });

    it('sets fresh data after TTL expires', async () => {
        setSpy.mockClear();

        await adminClient.query(MeDocument);
        expect(setSpy.mock.calls.length).toBe(0);

        await adminClient.query(MeDocument);
        expect(setSpy.mock.calls.length).toBe(0);

        await pause(2000);

        await adminClient.query(MeDocument);
        expect(setSpy.mock.calls.length).toBe(1);
    });

    it('clears cache for that user on logout', async () => {
        deleteSpy.mockClear();
        expect(deleteSpy.mock.calls.length).toBe(0);
        await adminClient.query(logoutDocument);

        expect(testSessionCache.size).toBe(0);
        expect(deleteSpy.mock.calls.length).toBeGreaterThan(0);
    });
});

describe('Session expiry', () => {
    const { server, adminClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            authOptions: {
                sessionDuration: '3s',
                sessionCacheTTL: 1,
            },
        }),
    );

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('session does not expire with continued use', async () => {
        await adminClient.asSuperAdmin();
        await pause(1000);
        await adminClient.query(MeDocument);
        await pause(1000);
        await adminClient.query(MeDocument);
        await pause(1000);
        await adminClient.query(MeDocument);
        await pause(1000);
        await adminClient.query(MeDocument);
    }, 10000);

    it('session expires when not used for longer than sessionDuration', async () => {
        await adminClient.asSuperAdmin();
        await pause(3500);
        try {
            await adminClient.query(MeDocument);
            fail('Should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('You are not currently authorized to perform this action');
        }
    }, 10000);
});

describe('Logout behavior', () => {
    const config = testConfig();
    const { server, adminClient } = createTestEnvironment(config);

    // Create a second client to simulate a different session
    const { port, adminApiPath } = config.apiOptions;
    const secondAdminClient = new SimpleGraphQLClient(config, `http://localhost:${port}/${adminApiPath!}`);

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-minimal.csv'),
            customerCount: 1,
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('logout only removes the active session', async () => {
        // Login with the first client
        await adminClient.query(attemptLoginDocument, {
            username: SUPER_ADMIN_USER_IDENTIFIER,
            password: SUPER_ADMIN_USER_PASSWORD,
        });

        // Verify the first client is logged in
        const { me: me1 } = await adminClient.query(MeDocument);
        expect(me1?.identifier).toBe(SUPER_ADMIN_USER_IDENTIFIER);

        // Login with the second client (creates a second session for the same user)
        await secondAdminClient.query(attemptLoginDocument, {
            username: SUPER_ADMIN_USER_IDENTIFIER,
            password: SUPER_ADMIN_USER_PASSWORD,
        });

        // Verify the second client is logged in
        const { me: me2 } = await secondAdminClient.query(MeDocument);
        expect(me2?.identifier).toBe(SUPER_ADMIN_USER_IDENTIFIER);

        // Logout from the first client
        const { logout } = await adminClient.query(logoutDocument);
        expect(logout.success).toBe(true);

        // Verify the first client is now logged out
        try {
            await adminClient.query(MeDocument);
            fail('Should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('You are not currently authorized to perform this action');
        }

        // Verify the second client is still logged in
        const { me: me3 } = await secondAdminClient.query(MeDocument);
        expect(me3?.identifier).toBe(SUPER_ADMIN_USER_IDENTIFIER);
    });

    it('logoutEverywhere removes all sessions for the user', async () => {
        // Login with the first client
        await adminClient.query(attemptLoginDocument, {
            username: SUPER_ADMIN_USER_IDENTIFIER,
            password: SUPER_ADMIN_USER_PASSWORD,
        });

        // Verify the first client is logged in
        const { me: me1 } = await adminClient.query(MeDocument);
        expect(me1?.identifier).toBe(SUPER_ADMIN_USER_IDENTIFIER);

        // Login with the second client (creates a second session for the same user)
        await secondAdminClient.query(attemptLoginDocument, {
            username: SUPER_ADMIN_USER_IDENTIFIER,
            password: SUPER_ADMIN_USER_PASSWORD,
        });

        // Verify the second client is logged in
        const { me: me2 } = await secondAdminClient.query(MeDocument);
        expect(me2?.identifier).toBe(SUPER_ADMIN_USER_IDENTIFIER);

        // Logout everywhere from the first client
        const { logoutEverywhere } = await adminClient.query(logoutEverywhereDocument);
        expect(logoutEverywhere.success).toBe(true);

        // Verify the first client is now logged out
        try {
            await adminClient.query(MeDocument);
            fail('Should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('You are not currently authorized to perform this action');
        }

        // Verify the second client is also logged out
        try {
            await secondAdminClient.query(MeDocument);
            fail('Should have thrown');
        } catch (e: any) {
            expect(e.message).toContain('You are not currently authorized to perform this action');
        }
    });
});

function pause(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
