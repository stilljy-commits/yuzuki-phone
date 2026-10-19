import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const updateLog = JSON.parse(fs.readFileSync(new URL('../update-log.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('current integrated version publishes its features and preserves upstream release notes', () => {
    const current = updateLog.versions[manifest.version];

    assert.equal(manifest.version, '1.6.3-p5');
    assert.match(indexSource, /const ST_PHONE_VERSION = '1\.6\.3-p5';/);
    assert.equal(manifest.auto_update, false);
    assert.equal(manifest.generate_interceptor, 'yuzukiPhoneGenerateInterceptor');
    assert.ok(updateLog.versions['1.6.3']);
    assert.ok(updateLog.versions['1.6.3-p2']);
    assert.ok(updateLog.versions['1.6.3-p3']);
    assert.ok(updateLog.versions['1.6.3-p4']);
    assert.equal(current.date, '2026-10-20');
    assert.equal(current.items.length, 4);
    assert.ok(current.items.some(item => item.includes('音色池')));
    assert.ok(current.items.some(item => item.includes('试听')));
    assert.equal(current.updates, undefined);
});

test('local update announcements are acknowledged by version and date', () => {
    assert.match(indexSource, /function normalizeUpdateLogEntry\(version, entry\)/);
    assert.match(indexSource, /phone-update-announcement-seen-release/);
    assert.match(indexSource, /const announcementId = `\$\{ST_PHONE_VERSION\}@\$\{String\(notes\?\.date/);
    assert.match(indexSource, /rememberValue: announcementId/);
    assert.match(indexSource, /options\.rememberValue \|\| version/);
});

test('fallback announcement matches the integrated release notice', () => {
    const start = indexSource.indexOf('const ST_PHONE_CURRENT_UPDATE =');
    const end = indexSource.indexOf('\n};', start);
    assert.ok(start >= 0 && end > start, 'fallback update block should exist');

    const block = indexSource.slice(start, end);
    assert.match(block, /date: '2026-10-20'/);
    for (const item of updateLog.versions[manifest.version].items) {
        assert.ok(block.includes(item), 'fallback should include each current announcement item');
    }
});
