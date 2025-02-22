import fs from 'fs';
import puppeteer from 'puppeteer';
import PDFMerger from 'pdf-merger-js';
import minimist from 'minimist';

const argv = minimist(process.argv.slice(2));

const formatTime = (v) => `${v.toFixed(4)} ms`;
const formatRegression = (v) => v.correlation < 0.9 ? '\u2620\uFE0F' : v.correlation < 0.99 ? '\u26A0\uFE0F' : ' ';

const dir = './bench/results';
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
}

const url = new URL('http://localhost:9966/bench/versions/');

for (const compare of [].concat(argv.compare).filter(Boolean))
    url.searchParams.append('compare', compare);

const browser = await puppeteer.launch({
    headless: true,
    args: ['--use-gl=angle', '--no-sandbox', '--disable-setuid-sandbox']
});

try {
    const webPage = await browser.newPage();

    url.hash = 'NONE';
    await webPage.goto(url);
    await webPage.waitForFunction(() => window.maplibreglBenchmarkFinished);
    const allNames = await webPage.evaluate(() => Object.keys(window.maplibreglBenchmarks));
    const versions = await webPage.evaluate((name) => Object.keys(window.maplibreglBenchmarks[name]), allNames[0]);

    const toRun = argv._.length > 0 ? argv._ : allNames;

    const nameWidth = Math.max(...toRun.map(v => v.length)) + 1;
    const timeWidth = Math.max(...versions.map(v => v.length), 16);

    console.log(''.padStart(nameWidth), ...versions.map(v =>  `${v.padStart(timeWidth)} `));

    const merger = new PDFMerger();
    for (const name of toRun) {
        process.stdout.write(name.padStart(nameWidth));

        url.hash = name;
        await webPage.goto(url);
        await webPage.reload();

        await webPage.waitForFunction(
            () => window.maplibreglBenchmarkFinished,
            {
                polling: 200,
                timeout: 0
            }
        );

        const results = await webPage.evaluate((name) => window.maplibreglBenchmarkResults[name], name);
        const output = versions.map((v) => formatTime(results[v].summary.trimmedMean).padStart(timeWidth) + formatRegression(results[v].regression));
        if (versions.length === 2) {
            const [main, current] = versions;
            const delta = results[current].summary.trimmedMean - results[main].summary.trimmedMean;
            output.push(((delta > 0 ? '+' : '') + formatTime(delta)).padStart(15));
        }
        console.log(...output);

        merger.add(await webPage.pdf({
            format: 'A4',
            path: `${dir}/${name}.pdf`,
            printBackground: true,
            margin: {
                top: '1cm',
                bottom: '1cm',
                left: '1cm',
                right: '1cm'
            }
        }));
    }

    await merger.save(`${dir}/all.pdf`);
} catch (error) {
    console.log(error);
    if (error.message.startsWith('net::ERR_CONNECTION_REFUSED')) {
        console.log('Could not connect to server. Please run \'npm run start-bench\'.');
    }
} finally {
    browser.close();
}
