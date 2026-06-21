// In-memory session store with automatic TTL expiry.
// Avoids synchronous disk I/O (readFileSync/writeFileSync) which blocks
// the Node.js event loop and causes race conditions under concurrent load.

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes of inactivity → session expires

// Map<phone, { state: string, data: object, expiresAt: number }>
const sessions = new Map();

// Purge expired sessions every 10 minutes to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    let purged = 0;
    for (const [phone, session] of sessions.entries()) {
        if (now >= session.expiresAt) {
            sessions.delete(phone);
            purged++;
        }
    }
    if (purged > 0) {
        console.log(`🧹 Session GC: purged ${purged} expired session(s).`);
    }
}, 10 * 60 * 1000);

export const SessionManager = {
    /**
     * Get the session for a phone number.
     * Returns a default START session if none exists or if it has expired.
     */
    get(phone) {
        const session = sessions.get(phone);
        if (!session || Date.now() >= session.expiresAt) {
            // Expired or missing — treat as a fresh start
            if (session) sessions.delete(phone);
            return { state: 'START', data: {} };
        }
        return session;
    },

    /**
     * Set the session state (and optionally merge new data).
     * Resets the TTL timer on every update.
     */
    set(phone, state, data = {}) {
        const existing = sessions.get(phone);
        sessions.set(phone, {
            state,
            // Merge new data on top of existing data so we don't lose keluhan
            // when transitioning from AWAITING_KELUHAN → AWAITING_GEJALA_CHOICE
            data: { ...(existing?.data || {}), ...data },
            expiresAt: Date.now() + SESSION_TTL_MS,
        });
    },

    /**
     * Clear the session for a phone number (end of consultation).
     */
    clear(phone) {
        sessions.delete(phone);
    },

    /**
     * Check the status of a session WITHOUT modifying it.
     * Returns:
     *   'none'    — no session record exists (brand new user)
     *   'active'  — session exists and has not expired
     *   'expired' — session exists but TTL has passed
     *
     * Use this BEFORE calling get() to detect expiry and send a notice.
     */
    checkExpiry(phone) {
        const session = sessions.get(phone);
        if (!session) return 'none';
        return Date.now() >= session.expiresAt ? 'expired' : 'active';
    },

    /**
     * Returns the number of active sessions (for health/debug endpoints).
     */
    count() {
        return sessions.size;
    },
};