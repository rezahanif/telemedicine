/**
 * ingest.js — One-off CLI script to populate Firebase with medical knowledge.
 * Run with: node src/ingest.js
 *
 * This is NOT part of the live bot server. It is a standalone utility to be
 * run manually whenever the CSV knowledge base is updated.
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { GoogleGenAI } from '@google/genai';

// --- Initialize Firebase & Gemini ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(fs.readFileSync('./firebase-service-account.json', 'utf8'));
} catch (err) {
    console.error('❌ FATAL: Could not load firebase-service-account.json:', err.message);
    process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- Config ---
const CSV_FILE = './Medika_KnowledgeBase_.csv';
const DELAY_MS = 600; // delay between rows to stay within Gemini API rate limits

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getEmbedding(text) {
    const response = await ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: text,
        config: { outputDimensionality: 768 }
    });
    const values = response?.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
        throw new Error('Gemini returned an empty or malformed embedding.');
    }
    return values;
}

/**
 * Checks if a document ID already exists in Firestore.
 * Used to skip rows that were already successfully uploaded (resume support).
 */
async function docExists(docId) {
    const snap = await db.collection('medical_knowledge').doc(docId).get();
    return snap.exists;
}

async function ingestRow(content, metadata, docId) {
    const vectorArray = await getEmbedding(content);
    await db.collection('medical_knowledge').doc(docId).set({
        content,
        metadata,
        embedding: FieldValue.vector(vectorArray)
    });
}

// ---------------------------------------------------------------------------
// Main ingestion loop
// ---------------------------------------------------------------------------

async function runIngestion() {
    // 1. Safety check
    if (!fs.existsSync(CSV_FILE)) {
        console.error(`❌ CSV file not found at: ${CSV_FILE}`);
        console.error('   Drop the file in the project root and try again.');
        process.exit(1);
    }

    console.log('📖 Parsing CSV...');
    const rawCsv = fs.readFileSync(CSV_FILE, 'utf8');
    const records = parse(rawCsv, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    console.log(`📦 Found ${records.length} records. Starting upload...\n`);

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < records.length; i++) {
        const row = records[i];

        // Use the CSV's NO column as the stable document ID.
        // Fallback to 1-based index if NO is missing to match human row numbers.
        const docId = String(row['NO'] || i + 1);
        const label = row['NAMA KELUHAN'] || `Row ${docId}`;

        // --- Resume support: skip rows already in Firestore ---
        const alreadyExists = await docExists(docId);
        if (alreadyExists) {
            console.log(`⏭️  [${i + 1}/${records.length}] Skipping (already uploaded): ${label}`);
            skipped++;
            continue;
        }

        // Build the searchable text block embedded into the vector
        const content = [
            `Keluhan: ${row['NAMA KELUHAN'] || ''}`,
            `Gejala: ${row['GEJALA PENYERTA / PEMBEDA'] || ''}`,
            `Urgensi: ${row['TINGKAT URGENSI'] || ''}`,
            `Tindakan: ${row['REKOMENDASI TINDAKAN'] || ''}`,
            `Obat: ${row['REKOMENDASI PRODUK/OBAT'] || ''}`,
            `Red flag: ${row['KONDISI BAHAYA / RED FLAG'] || ''}`,
            `Catatan: ${row['CATATAN KHUSUS'] || ''}`,
        ].join('\n');

        // Structured metadata stored alongside the vector for bot responses
        const metadata = {
            no: docId,
            nama_keluhan: row['NAMA KELUHAN'] || '',
            urgensi: row['TINGKAT URGENSI'] || '',
            tindakan: row['REKOMENDASI TINDAKAN'] || '',
            produk: row['REKOMENDASI PRODUK/OBAT'] || '',
            red_flag: row['KONDISI BAHAYA / RED FLAG'] || '',
            disclaimer: row['WAJIB DISCLAIMER'] || '',
            catatan: row['CATATAN KHUSUS'] || '',
        };

        try {
            console.log(`⏳ [${i + 1}/${records.length}] Uploading: ${label}`);
            await ingestRow(content, metadata, docId);
            console.log(`✅ [${i + 1}/${records.length}] Done: ${label}`);
            uploaded++;
        } catch (err) {
            console.error(`❌ [${i + 1}/${records.length}] Failed: ${label} — ${err.message}`);
            failed++;
            // Continue with next row instead of aborting the whole run
        }

        // Throttle to avoid hitting Gemini API rate limits
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }

    console.log('\n─────────────────────────────────────');
    console.log(`✅ Ingestion complete!`);
    console.log(`   Uploaded : ${uploaded}`);
    console.log(`   Skipped  : ${skipped} (already existed)`);
    console.log(`   Failed   : ${failed}`);
    console.log('─────────────────────────────────────');
}

runIngestion();