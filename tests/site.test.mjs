import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://financialpros.brotherfall.com';
const pages = readdirSync(root).filter(name => name.endsWith('.html'));
const read = name => readFileSync(join(root, name), 'utf8');
const attributes = tag => Object.fromEntries(
  [...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(match => [match[1], match[2]])
);
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))]
  .map(match => attributes(match[0]));
const canonicalFor = name => `${origin}/${name === 'index.html' ? '' : name}`;

test('every page has unique search metadata and one main heading', () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const name of pages) {
    const html = read(name);
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    const meta = tags(html, 'meta');
    const description = meta.find(tag => tag.name === 'description')?.content;
    assert.ok(title && title.length <= 75, `${name}: descriptive title`);
    assert.ok(description && description.length >= 70 && description.length <= 200, `${name}: description`);
    assert.ok(!titles.has(title), `${name}: unique title`);
    assert.ok(!descriptions.has(description), `${name}: unique description`);
    titles.add(title);
    descriptions.add(description);
    assert.equal(tags(html, 'h1').length, 1, `${name}: one H1`);
    assert.equal(tags(html, 'main').length, 1, `${name}: main landmark`);
    assert.match(html, /<html lang="en">/, `${name}: language`);
    assert.equal(tags(html, 'link').find(tag => tag.rel === 'canonical')?.href, canonicalFor(name));
    assert.equal(meta.find(tag => tag.property === 'og:url')?.content, canonicalFor(name));
    assert.ok(meta.find(tag => tag.property === 'og:title')?.content);
    assert.ok(meta.find(tag => tag.property === 'og:description')?.content);
    assert.equal(meta.find(tag => tag.name === 'twitter:card')?.content, 'summary');
    assert.equal(meta.find(tag => tag.name === 'robots')?.content, 'index,follow');
  }
});

test('local links, fragments, scripts, and styles resolve', () => {
  for (const name of pages) {
    const html = read(name);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${name}: no duplicate IDs`);
    const references = [
      ...tags(html, 'a').map(tag => tag.href),
      ...tags(html, 'link').map(tag => tag.href),
      ...tags(html, 'script').map(tag => tag.src),
    ].filter(Boolean);
    for (const ref of references) {
      const url = new URL(ref, `${origin}/${name}`);
      if (url.origin !== origin) continue;
      const file = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      assert.ok(existsSync(join(root, file)), `${name}: missing ${ref}`);
      if (url.hash) {
        const fragment = decodeURIComponent(url.hash.slice(1));
        assert.ok(tags(read(file), '[a-z][a-z0-9]*').some(tag => tag.id === fragment),
          `${name}: missing fragment ${ref}`);
      }
    }
    const toggle = tags(html, 'button').find(tag => tag.class === 'nav-toggle');
    assert.equal(toggle?.['aria-expanded'], 'false', `${name}: menu state`);
    assert.ok(ids.includes(toggle?.['aria-controls']), `${name}: menu target`);
    for (const policy of ['privacy.html', 'terms.html', 'editorial-policy.html', 'protection-guide.html']) {
      assert.ok(tags(html, 'a').some(tag => tag.href === policy), `${name}: ${policy} discoverable`);
    }
    const phones = tags(html, 'a').filter(tag => tag.href?.startsWith('tel:'));
    assert.ok(phones.every(tag => tag.href === 'tel:+16144325242'), `${name}: confirmed phone`);
    assert.doesNotMatch(html, /6147792576|614-779-2576|consultationForm|formSuccess/);
  }
});

test('every page uses the branded SVG favicon', () => {
  const svg = read('favicon.svg');
  assert.match(svg, /<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 64 64"/);
  assert.match(svg, /<title>TrueVine Legacy LLC<\/title>/);
  for (const name of pages) {
    const icons = tags(read(name), 'link').filter(tag => tag.rel === 'icon');
    assert.equal(icons.length, 1, `${name}: one favicon`);
    assert.equal(icons[0].href, 'favicon.svg');
    assert.equal(icons[0].type, 'image/svg+xml');
    assert.equal(icons[0].sizes, 'any');
  }
});

test('visible logos consistently use TrueVine Legacy LLC', () => {
  for (const name of pages) {
    const html = read(name);
    const logos = [...html.matchAll(/<div class="logo-text">([\s\S]*?)<\/div>/g)];
    assert.equal(logos.length, 2, `${name}: navigation and footer logos`);
    for (const logo of logos) {
      assert.match(logo[1], /TrueVine Legacy LLC/);
      assert.doesNotMatch(logo[1], /TrueVine Financial/);
    }
    assert.match(html, /aria-label="TrueVine Legacy LLC Home"/);
  }
  assert.match(read('index.html'), /class="shield-llc">Legacy LLC<\/div>/);
});

test('sitemap covers exactly the canonical pages and robots advertises it', () => {
  const sitemap = read('sitemap.xml');
  assert.match(sitemap, /xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/);
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(locations).size, locations.length);
  assert.deepEqual(locations.sort(), pages.map(canonicalFor).sort());
  assert.match(read('robots.txt'), /User-agent: \*\s+Allow: \//);
  assert.ok(read('robots.txt').includes(`Sitemap: ${origin}/sitemap.xml`));
});

test('structured data is valid JSON and represents visible content', () => {
  for (const name of pages) {
    for (const match of read(name).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const data = JSON.parse(match[1]);
      assert.equal(data['@context'], 'https://schema.org');
      assert.ok(data['@type'] || data['@graph']);
      assert.doesNotMatch(match[1], /AggregateRating|Review|FinancialAdvisor/);
    }
  }
});

test('guide arithmetic and disclosure remain consistent', () => {
  assert.equal(2500 * 12 * 8 + 80000 + 20000 + 40000 - 30000 - 100000, 250000);
  assert.equal(300000 - 60000, 240000);
  assert.equal(7200 / 3600, 2);
  const guide = read('protection-guide.html');
  for (const value of ['$240,000', '$250,000', '$380,000', '$130,000']) {
    assert.ok(guide.includes(value), `worked example includes ${value}`);
  }
  assert.match(guide, /Examples are hypothetical/);
  assert.match(read('privacy.html'), /AdSense is not currently activated/);
  assert.ok(!existsSync(join(root, 'ads.txt')), 'no invented publisher record');
  for (const name of pages) {
    assert.doesNotMatch(read(name), /adsbygoogle|googletagmanager|google-analytics/);
  }
});
