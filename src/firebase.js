import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// NOTE: dotenv.config() is intentionally NOT called here.
// It must be called once at the entry point (src/index.js) before any imports resolve.

// --- Firebase Admin SDK initialization ---
// cert() also accepts a file path string directly, but parsing manually
// gives a clearer error message if the file is missing or malformed.
let serviceAccount;
try {
    serviceAccount = JSON.parse(fs.readFileSync('./firebase-service-account.json', 'utf8'));
} catch (err) {
    console.error('❌ FATAL: Could not load firebase-service-account.json:', err.message);
    process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceAccountPath = path.resolve(__dirname, '../firebase-service-account.json');

// Initialize Firebase App (for general admin purposes)
const app = initializeApp({ credential: cert(serviceAccount) });

// Explicitly instantiate Firestore with keyFilename instead of setting the global
// GOOGLE_APPLICATION_CREDENTIALS. This ensures Firestore's internal gRPC client
// has the credentials it needs for findNearest(), WITHOUT bleeding those
// credentials into the GoogleGenAI client (which caused a 403 scope error).
const db = new Firestore({
    credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key
    },
    projectId: serviceAccount.project_id
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function getEmbedding(text) {
    const response = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: text,
        config: { outputDimensionality: 768 }
    });

    // Safety guard: ensure the API returned a valid embedding array
    const values = response?.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
        throw new Error('Gemini embedContent returned an empty or malformed embedding.');
    }
    return values;
}

// ---------------------------------------------------------------------------
// RAG Search — used by the live bot
// ---------------------------------------------------------------------------

/**
 * Embeds queryText and finds the top-3 most similar documents in Firestore
 * using the stable findNearest() vector search API.
 * Returns the matched document contents joined as a single context string,
 * or an empty string if nothing is close enough.
 */
export async function searchKnowledge(queryText) {
    try {
        const queryVector = await getEmbedding(queryText);

        // Use the stable, production-ready findNearest() API (not the preview pipeline API)
        const vectorQuery = db.collection('medical_knowledge').findNearest({
            vectorField: 'embedding',
            queryVector,
            limit: 3,
            distanceMeasure: 'COSINE',
            distanceResultField: '_distance', // optional: stores score in each result doc
        });

        const snapshot = await vectorQuery.get();

        if (snapshot.empty) return '';

        // Filter client-side for similarity threshold (cosine distance ≤ 0.3 = similarity ≥ 0.70)
        const relevant = snapshot.docs.filter(doc => {
            const dist = doc.get('_distance');
            return dist === undefined || dist <= 0.3; // include if field not present (fallback)
        });

        if (relevant.length === 0) return '';

        return relevant.map(doc => doc.data().content).join('\n\n');
    } catch (err) {
        console.error('❌ Firebase RAG lookup failed:', err.message);
        return '';
    }
}

// ---------------------------------------------------------------------------
// Symptom list — used by the bot to build the numbered menu
// ---------------------------------------------------------------------------

// In-memory cache so we don't download the full collection on every consultation.
// Firestore charges per-document-read, so fetching 500 docs on every user session
// would be extremely expensive. This cache refreshes every 60 minutes.
let _symptomsCache = null;
let _symptomsCacheExpiry = 0;
const SYMPTOMS_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Returns a deduplicated list of all `nama_keluhan` values from the database.
 * Results are cached in memory and refreshed every 60 minutes.
 */
export async function getDistinctSymptoms() {
    const now = Date.now();

    // Return cached result if still fresh
    if (_symptomsCache && now < _symptomsCacheExpiry) {
        return _symptomsCache;
    }

    try {
        // Only fetch the metadata field — no need to download embeddings (large vectors)
        const snapshot = await db.collection('medical_knowledge')
            .select('metadata.nama_keluhan') // Only retrieve this specific field
            .get();

        const symptoms = [];
        snapshot.forEach(doc => {
            const name = doc.get('metadata.nama_keluhan');
            if (name) symptoms.push(name);
        });

        const uniqueSymptoms = [...new Set(symptoms)];

        // Store in cache
        _symptomsCache = uniqueSymptoms;
        _symptomsCacheExpiry = now + SYMPTOMS_CACHE_TTL_MS;

        console.log(`✅ Symptoms cache refreshed: ${uniqueSymptoms.length} unique conditions loaded.`);
        return uniqueSymptoms;
    } catch (err) {
        console.error('❌ Error fetching symptoms:', err.message);
        // On error, return stale cache if available rather than an empty list
        return _symptomsCache || [];
    }
}