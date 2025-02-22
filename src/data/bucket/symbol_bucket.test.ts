import fs from 'fs';
import path from 'path';
import Protobuf from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import SymbolBucket from './symbol_bucket';
import {CollisionBoxArray} from '../../data/array_types';
import {performSymbolLayout} from '../../symbol/symbol_layout';
import {Placement} from '../../symbol/placement';
import Transform from '../../geo/transform';
import {OverscaledTileID} from '../../source/tile_id';
import Tile from '../../source/tile';
import CrossTileSymbolIndex from '../../symbol/cross_tile_symbol_index';
import FeatureIndex from '../../data/feature_index';
import {createSymbolBucket, createSymbolIconBucket} from '../../../test/util/create_symbol_layer';
import {RGBAImage} from '../../util/image';
import {ImagePosition} from '../../render/image_atlas';
import {IndexedFeature, PopulateParameters} from '../bucket';
import {StyleImage} from '../../style/style_image';
import glyphs from '../../../test/fixtures/fontstack-glyphs.json';
import {StyleGlyph} from '../../style/style_glyph';

// Load a point feature from fixture tile.
const vt = new VectorTile(new Protobuf(fs.readFileSync(path.resolve(__dirname, '../../../test/fixtures/mbsv5-6-18-23.vector.pbf'))));
const feature = vt.layers.place_label.feature(10);

/*eslint new-cap: 0*/
const collisionBoxArray = new CollisionBoxArray();
const transform = new Transform();
transform.width = 100;
transform.height = 100;
transform.cameraToCenterDistance = 100;

const stacks = {'Test': glyphs} as any as {
    [_: string]: {
        [x: number]: StyleGlyph;
    };
};

function bucketSetup(text = 'abcde') {
    return createSymbolBucket('test', 'Test', text, collisionBoxArray);
}

function createIndexedFeature(id, index, iconId) {
    return {
        feature: {
            extent: 8192,
            type: 1,
            id,
            properties: {
                icon: iconId
            },
            loadGeometry () {
                return [[{x: 0, y: 0}]];
            }
        },
        id,
        index,
        sourceLayerIndex: 0
    };
}

describe('SymbolBucket', () => {
    test('SymbolBucket', () => {
        const bucketA = bucketSetup() as any as SymbolBucket;
        const bucketB = bucketSetup() as any as SymbolBucket;
        const options = {iconDependencies: {}, glyphDependencies: {}} as PopulateParameters;
        const placement = new Placement(transform, 0, true);
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const crossTileSymbolIndex = new CrossTileSymbolIndex();

        // add feature from bucket A
        bucketA.populate([{feature} as IndexedFeature], options, undefined);
        performSymbolLayout(bucketA, stacks, {}, undefined, undefined, undefined, undefined);
        const tileA = new Tile(tileID, 512);
        tileA.latestFeatureIndex = new FeatureIndex(tileID);
        tileA.buckets = {test: bucketA};
        tileA.collisionBoxArray = collisionBoxArray;

        // add same feature from bucket B
        bucketB.populate([{feature} as IndexedFeature], options, undefined);
        performSymbolLayout(bucketB, stacks, {}, undefined, undefined, undefined, undefined);
        const tileB = new Tile(tileID, 512);
        tileB.buckets = {test: bucketB};
        tileB.collisionBoxArray = collisionBoxArray;

        crossTileSymbolIndex.addLayer(bucketA.layers[0], [tileA, tileB], undefined);

        const place = (layer, tile) => {
            const parts = [];
            placement.getBucketParts(parts, layer, tile, false);
            for (const part of parts) {
                placement.placeLayerBucketPart(part, {}, false);
            }
        };
        const a = placement.collisionIndex.grid.keysLength();
        place(bucketA.layers[0], tileA);
        const b = placement.collisionIndex.grid.keysLength();
        expect(a).not.toBe(b);

        const a2 = placement.collisionIndex.grid.keysLength();
        place(bucketB.layers[0], tileB);
        const b2 = placement.collisionIndex.grid.keysLength();
        expect(b2).toBe(a2);
    });

    test('SymbolBucket integer overflow', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        SymbolBucket.MAX_GLYPHS = 5;

        const bucket = bucketSetup() as any as SymbolBucket;
        const options = {iconDependencies: {}, glyphDependencies: {}} as PopulateParameters;

        bucket.populate([{feature} as IndexedFeature], options, undefined);
        const fakeGlyph = {rect: {w: 10, h: 10}, metrics: {left: 10, top: 10, advance: 10}};
        performSymbolLayout(bucket, stacks, {'Test': {97: fakeGlyph, 98: fakeGlyph, 99: fakeGlyph, 100: fakeGlyph, 101: fakeGlyph, 102: fakeGlyph} as any}, undefined, undefined, undefined, undefined);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0].includes('Too many glyphs being rendered in a tile.')).toBeTruthy();
    });

    test('SymbolBucket image undefined sdf', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        spy.mockReset();

        const imageMap = {
            a: {
                data: new RGBAImage({width: 0, height: 0})
            },
            b: {
                data: new RGBAImage({width: 0, height: 0}),
                sdf: false
            }
        } as any as { [_: string]: StyleImage };
        const imagePos = {
            a: new ImagePosition({x: 0, y: 0, w: 10, h: 10}, 1 as any as StyleImage),
            b: new ImagePosition({x: 10, y: 0, w: 10, h: 10}, 1 as any as StyleImage)
        };
        const bucket = createSymbolIconBucket('test', 'icon', collisionBoxArray) as any as SymbolBucket;
        const options = {iconDependencies: {}, glyphDependencies: {}} as PopulateParameters;

        bucket.populate(
        [
            createIndexedFeature(0, 0, 'a'),
            createIndexedFeature(1, 1, 'b'),
            createIndexedFeature(2, 2, 'a')
        ] as any as IndexedFeature[],
        options, undefined
        );

        const icons = options.iconDependencies as any;
        expect(icons.a).toBe(true);
        expect(icons.b).toBe(true);

        performSymbolLayout(bucket, null, null, imageMap, imagePos, undefined, undefined);

        // undefined SDF should be treated the same as false SDF - no warning raised
        expect(spy).not.toHaveBeenCalledTimes(1);
    });

    test('SymbolBucket image mismatched sdf', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        spy.mockReset();

        const imageMap = {
            a: {
                data: new RGBAImage({width: 0, height: 0}),
                sdf: true
            },
            b: {
                data: new RGBAImage({width: 0, height: 0}),
                sdf: false
            }
        } as any as { [_: string]: StyleImage };
        const imagePos = {
            a: new ImagePosition({x: 0, y: 0, w: 10, h: 10}, 1 as any as StyleImage),
            b: new ImagePosition({x: 10, y: 0, w: 10, h: 10}, 1 as any as StyleImage)
        };
        const bucket = createSymbolIconBucket('test', 'icon', collisionBoxArray) as any as SymbolBucket;
        const options = {iconDependencies: {}, glyphDependencies: {}} as PopulateParameters;

        bucket.populate(
        [
            createIndexedFeature(0, 0, 'a'),
            createIndexedFeature(1, 1, 'b'),
            createIndexedFeature(2, 2, 'a')
        ] as any as IndexedFeature[],
        options, undefined
        );

        const icons = options.iconDependencies as any;
        expect(icons.a).toBe(true);
        expect(icons.b).toBe(true);

        performSymbolLayout(bucket, null, null, imageMap, imagePos, undefined, undefined);

        // true SDF and false SDF in same bucket should trigger warning
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('SymbolBucket detects rtl text', () => {
        const rtlBucket = bucketSetup('مرحبا');
        const ltrBucket = bucketSetup('hello');
        const options = {iconDependencies: {}, glyphDependencies: {}} as PopulateParameters;
        rtlBucket.populate([{feature} as IndexedFeature], options, undefined);
        ltrBucket.populate([{feature} as IndexedFeature], options, undefined);

        expect(rtlBucket.hasRTLText).toBeTruthy();
        expect(ltrBucket.hasRTLText).toBeFalsy();
    });

    // Test to prevent symbol bucket with rtl from text being culled by worker serialization.
    test('SymbolBucket with rtl text is NOT empty even though no symbol instances are created', () => {
        const rtlBucket = bucketSetup('مرحبا');
        const options = {iconDependencies: {}, glyphDependencies: {}} as PopulateParameters;
        rtlBucket.createArrays();
        rtlBucket.populate([{feature} as IndexedFeature], options, undefined);

        expect(rtlBucket.isEmpty()).toBeFalsy();
        expect(rtlBucket.symbolInstances).toHaveLength(0);
    });

    test('SymbolBucket detects rtl text mixed with ltr text', () => {
        const mixedBucket = bucketSetup('مرحبا translates to hello');
        const options = {iconDependencies: {}, glyphDependencies: {}} as PopulateParameters;
        mixedBucket.populate([{feature} as IndexedFeature], options, undefined);

        expect(mixedBucket.hasRTLText).toBeTruthy();
    });
});
