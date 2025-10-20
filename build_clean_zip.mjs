// build_clean_zip.mjs
import fs from 'fs-extra';
import path from 'path';
import fg from 'fast-glob';
import sharp from 'sharp';
import { BlobWriter, ZipWriter } from '@zip.js/zip.js';
import slugifyLib from 'slugify';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** CONFIG **/
const SRC_ZIP = process.argv[2] || 'AMDA Website featured artists-20251019T211116Z-1-001.zip';
const OUT_ZIP = 'amda_cleaned_final.zip';
const OUT_CSV = 'artists_manifest.csv';
const OUT_RPT = 'import_report.csv';
const MAX_SIDE = 2000;   // px
const JPEG_QUALITY = 82; // %
const countryAlias = { uuganda: 'uganda' };
const validCountries = new Set(['rwanda','tanzania','uganda']);
const knownOrgs = {
  rwanda: new Set(['amizero-dance-kompagnie']),
  tanzania: new Set(['muda-africa']),
  uganda: new Set(['batalo-east','soul-xpressions'])
};
const imageExts = new Set(['.jpg','.jpeg','.png','.webp']);
const bioExts   = new Set(['.md','.txt','.rtf']);
const cvExts    = new Set(['.pdf','.doc','.docx']);

const slugify = s => slugifyLib(s, { lower:true, strict:true });
const titleCase = s => s.trim().split(/\s+/).map(p => p ? (p[0].toUpperCase()+p.slice(1).toLowerCase()) : p).join(' ');

/** unzip safely to a temp folder **/
const TMP = path.join(__dirname, '.tmp_extract');
await fs.remove(TMP);
await fs.mkdirp(TMP);

// fast system unzip
await new Promise((res, rej) => {
  const { exec } = require('child_process');
  exec(`unzip -q "${SRC_ZIP}" -d "${TMP}"`, (e) => e ? rej(e) : res());
});

// Find the real root (some exports nest under one folder)
function findRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes:true }).filter(d => d.name !== '__MACOSX');
  if (entries.length === 1 && entries[0].isDirectory()) {
    return findRoot(path.join(dir, entries[0].name));
  }
  return dir;
}
const ROOT = findRoot(TMP);

const normCountry = n => countryAlias[n.toLowerCase()] || n.toLowerCase();
const isArtistDir = (dir) => fg.sync(['*','**/*'], { cwd: dir, onlyFiles:true, dot:false, deep:2 }).length > 0;

// Scan: country / (org) / artist
const buckets = []; // { countryKey, orgName|null, artistPath }
for (const cName of fs.readdirSync(ROOT)) {
  const cPath = path.join(ROOT, cName);
  if (!fs.lstatSync(cPath).isDirectory()) continue;
  const cKey = normCountry(cName);
  if (!validCountries.has(cKey)) continue;

  const entries = fs.readdirSync(cPath, { withFileTypes:true }).filter(d => d.isDirectory());
  const presentOrgNames = new Set(entries.map(d => d.name.toLowerCase()));
  const recognized = new Set([...presentOrgNames].filter(n => knownOrgs[cKey]?.has(n)));

  if (recognized.size) {
    for (const od of entries) {
      const oname = od.name.toLowerCase();
      const orgPath = path.join(cPath, od.name);
      if (recognized.has(oname)) {
        const artists = fs.readdirSync(orgPath, { withFileTypes:true }).filter(d => d.isDirectory());
        for (const ad of artists) {
          const aPath = path.join(orgPath, ad.name);
          if (isArtistDir(aPath)) buckets.push({ countryKey:cKey, orgName:oname, artistPath:aPath });
        }
      } else {
        // stray artist dirs under country root
        const stray = path.join(cPath, od.name);
        if (isArtistDir(stray)) buckets.push({ countryKey:cKey, orgName:null, artistPath:stray });
      }
    }
  } else {
    for (const ad of entries) {
      const aPath = path.join(cPath, ad.name);
      if (isArtistDir(aPath)) buckets.push({ countryKey:cKey, orgName:null, artistPath:aPath });
    }
  }
}

// Zip writer
const blobWriter = new BlobWriter('application/zip');
const zipWriter = new ZipWriter(blobWriter);

const manifestRows = [];
const reportRows = [['slug','name','country','organization','hero','bio','cv','num_photos','notes']];

const imageP = (f) => imageExts.has(path.extname(f).toLowerCase());
const bioP   = (f) => bioExts.has(path.extname(f).toLowerCase());
const cvP    = (f) => cvExts.has(path.extname(f).toLowerCase());

const pickHero = (arr) => {
  const pri = (n) => {
    const L = path.basename(n).toLowerCase();
    return (L.startsWith('hero.')?4:0) + (L.startsWith('cover.')?3:0) + (L.startsWith('portrait.')?2:0) + (L.startsWith('profile.')?1:0);
  };
  return arr.sort((a,b)=>pri(b)-pri(a) || a.localeCompare(b))[0] || null;
};

async function addBuffer(destPath, buf){ await zipWriter.add(destPath, new Blob([buf])); }
async function addText(destPath, text){ await addBuffer(destPath, Buffer.from(text)); }

for (const b of buckets) {
  const baseName = path.basename(b.artistPath).replace(/[_-]+/g,' ').trim();
  const displayName = titleCase(baseName);
  const slug = slugify(displayName);

  const all = fg.sync(['**/*'], { cwd: b.artistPath, onlyFiles:true, dot:false })
               .map(p => path.join(b.artistPath, p));
  const imgs = all.filter(imageP);
  const bios = all.filter(bioP);
  const cvs  = all.filter(cvP);

  const heroCand = pickHero(imgs) || imgs[0] || null;
  const bioFile  = bios[0] || null;
  const cvFile   = cvs.find(f => f.toLowerCase().endsWith('.pdf')) || cvs[0] || null;

  const base = b.orgName ? `${b.countryKey}/${b.orgName}/${slug}` : `${b.countryKey}/${slug}`;

  // HERO → JPEG (≤2000px)
  let heroRel = '';
  if (heroCand) {
    const buf = await sharp(heroCand).rotate().resize({ width:2000, height:2000, fit:'inside', withoutEnlargement:true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    heroRel = `${base}/hero.jpg`;
    await addBuffer(heroRel, buf);
  }

  // GALLERY → JPEGs
  let count = 0;
  for (const f of imgs.filter(f => f !== heroCand)) {
    const jpg = await sharp(f).rotate().resize({ width:2000, height:2000, fit:'inside', withoutEnlargement:true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    const dest = `${base}/photos/${path.basename(f, path.extname(f))}.jpg`;
    await addBuffer(dest, jpg);
    count++;
  }

  // If no hero yet but we had images, promote first gallery file again as hero
  if (!heroRel && imgs.length) {
    const jpg = await sharp(imgs[0]).rotate().resize({ width:2000, height:2000, fit:'inside', withoutEnlargement:true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    heroRel = `${base}/hero.jpg`;
    await addBuffer(heroRel, jpg);
  }

  // BIO
  let bioRel = '';
  if (bioFile) {
    const text = await fs.readFile(bioFile, 'utf8');
    bioRel = `${base}/bio.md`;
    await addText(bioRel, text);
  }

  // CV
  let cvRel = '';
  if (cvFile) {
    const buf = await fs.readFile(cvFile);
    cvRel = `${base}/cv${path.extname(cvFile).toLowerCase()}`;
    await addBuffer(cvRel, buf);
  }

  manifestRows.push({
    slug,
    name: displayName,
    country: b.countryKey[0].toUpperCase()+b.countryKey.slice(1),
    organization: b.orgName || '',
    dance_styles: '',
    social_instagram: '',
    social_facebook: '',
    social_youtube: '',
    hero_path: heroRel || '',
    bio_path: bioRel || '',
    cv_path: cvRel || '',
    gallery_glob: `${base}/photos/*`
  });

  const notes = [];
  if (!heroRel) notes.push('no_hero');
  if (!bioRel)  notes.push('no_bio');
  if (!cvRel)   notes.push('no_cv');
  reportRows.push([slug, displayName, b.countryKey, b.orgName||'(none)', path.basename(heroRel||''), path.basename(bioRel||''), path.basename(cvRel||''), String(count), notes.join(';')]);
}

// Add manifest + report to ZIP (also write to disk)
const manifestCsvText = [
  'slug,name,country,organization,dance_styles,social_instagram,social_facebook,social_youtube,hero_path,bio_path,cv_path,gallery_glob',
  ...manifestRows.sort((a,b)=> (a.country+a.organization+a.name).localeCompare(b.country+b.organization+b.name))
    .map(r => [
      r.slug, `"${r.name}"`, r.country, r.organization, '',
      '', '', '',
      r.hero_path, r.bio_path, r.cv_path, r.gallery_glob
    ].join(','))
].join('\n');
const reportCsvText = reportRows.map(r => Array.isArray(r) ? r.join(',') : r).join('\n');

await addText(OUT_CSV, manifestCsvText);
await addText(OUT_RPT, reportCsvText);
await zipWriter.close();

// Write zip blob to file
const blob = await blobWriter.getData();
await fs.writeFile(OUT_ZIP, Buffer.from(await blob.arrayBuffer()));

// Also save CSVs next to ZIP for convenience
await fs.writeFile(OUT_CSV, manifestCsvText, 'utf8');
await fs.writeFile(OUT_RPT, reportCsvText, 'utf8');

console.log('DONE:', OUT_ZIP, OUT_CSV, OUT_RPT);
