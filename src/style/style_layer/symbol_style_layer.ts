import StyleLayer from '../style_layer';

import assert from 'assert';
import SymbolBucket from '../../data/bucket/symbol_bucket';
import resolveTokens from '../../util/resolve_tokens';
import properties, {SymbolLayoutPropsPossiblyEvaluated, SymbolPaintPropsPossiblyEvaluated} from './symbol_style_layer_properties';

import {
    Transitionable,
    Transitioning,
    Layout,
    PossiblyEvaluated,
    PossiblyEvaluatedPropertyValue,
    PropertyValue
} from '../properties';

import {
    isExpression,
    StyleExpression,
    ZoomConstantExpression,
    ZoomDependentExpression
} from '../../style-spec/expression';

import type {BucketParameters} from '../../data/bucket';
import type {SymbolLayoutProps, SymbolPaintProps} from './symbol_style_layer_properties';
import type EvaluationParameters from '../evaluation_parameters';
import type {LayerSpecification} from '../../style-spec/types';
import type {Feature, SourceExpression, CompositeExpression} from '../../style-spec/expression';
import type {Expression} from '../../style-spec/expression/expression';
import type {CanonicalTileID} from '../../source/tile_id';
import {FormattedType} from '../../style-spec/expression/types';
import {typeOf} from '../../style-spec/expression/values';
import Formatted from '../../style-spec/expression/types/formatted';
import FormatSectionOverride from '../format_section_override';
import FormatExpression from '../../style-spec/expression/definitions/format';
import Literal from '../../style-spec/expression/definitions/literal';

class SymbolStyleLayer extends StyleLayer {
    _unevaluatedLayout: Layout<SymbolLayoutProps>;
    layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>;

    _transitionablePaint: Transitionable<SymbolPaintProps>;
    _transitioningPaint: Transitioning<SymbolPaintProps>;
    paint: PossiblyEvaluated<SymbolPaintProps, SymbolPaintPropsPossiblyEvaluated>;

    constructor(layer: LayerSpecification) {
        super(layer, properties);
    }

    recalculate(parameters: EvaluationParameters, availableImages: Array<string>) {
        super.recalculate(parameters, availableImages);

        if (this.layout.get('icon-rotation-alignment') === 'auto') {
            if (this.layout.get('symbol-placement') !== 'point') {
                this.layout._values['icon-rotation-alignment'] = 'map';
            } else {
                this.layout._values['icon-rotation-alignment'] = 'viewport';
            }
        }

        if (this.layout.get('text-rotation-alignment') === 'auto') {
            if (this.layout.get('symbol-placement') !== 'point') {
                this.layout._values['text-rotation-alignment'] = 'map';
            } else {
                this.layout._values['text-rotation-alignment'] = 'viewport';
            }
        }

        // If unspecified, `*-pitch-alignment` inherits `*-rotation-alignment`
        if (this.layout.get('text-pitch-alignment') === 'auto') {
            this.layout._values['text-pitch-alignment'] = this.layout.get('text-rotation-alignment');
        }
        if (this.layout.get('icon-pitch-alignment') === 'auto') {
            this.layout._values['icon-pitch-alignment'] = this.layout.get('icon-rotation-alignment');
        }

        if (this.layout.get('symbol-placement') === 'point') {
            const writingModes = this.layout.get('text-writing-mode');
            if (writingModes) {
                // remove duplicates, preserving order
                const deduped = [];
                for (const m of writingModes) {
                    if (deduped.indexOf(m) < 0) deduped.push(m);
                }
                this.layout._values['text-writing-mode'] = deduped;
            } else {
                this.layout._values['text-writing-mode'] = ['horizontal'];
            }
        }

        this._setPaintOverrides();
    }

    getValueAndResolveTokens(name: any, feature: Feature, canonical: CanonicalTileID, availableImages: Array<string>) {
        const value = this.layout.get(name).evaluate(feature, {}, canonical, availableImages);
        const unevaluated = this._unevaluatedLayout._values[name];
        if (!unevaluated.isDataDriven() && !isExpression(unevaluated.value) && value) {
            return resolveTokens(feature.properties, value);
        }

        return value;
    }

    createBucket(parameters: BucketParameters<any>) {
        return new SymbolBucket(parameters);
    }

    queryRadius(): number {
        return 0;
    }

    queryIntersectsFeature(): boolean {
        assert(false); // Should take a different path in FeatureIndex
        return false;
    }

    _setPaintOverrides() {
        for (const overridable of properties.paint.overridableProperties) {
            if (!SymbolStyleLayer.hasPaintOverride(this.layout, overridable)) {
                continue;
            }
            const overriden = this.paint.get(overridable as keyof SymbolPaintPropsPossiblyEvaluated) as PossiblyEvaluatedPropertyValue<number>;
            const override = new FormatSectionOverride(overriden);
            const styleExpression = new StyleExpression(override, overriden.property.specification);
            let expression = null;
            if (overriden.value.kind === 'constant' || overriden.value.kind === 'source') {
                expression = (new ZoomConstantExpression('source', styleExpression) as SourceExpression);
            } else {
                expression = (new ZoomDependentExpression('composite',
                                                          styleExpression,
                                                          overriden.value.zoomStops,
                                                          (overriden.value as any)._interpolationType) as CompositeExpression);
            }
            this.paint._values[overridable] = new PossiblyEvaluatedPropertyValue(overriden.property,
                                                                                 expression,
                                                                                 overriden.parameters);
        }
    }

    _handleOverridablePaintPropertyUpdate<T, R>(name: string, oldValue: PropertyValue<T, R>, newValue: PropertyValue<T, R>): boolean {
        if (!this.layout || oldValue.isDataDriven() || newValue.isDataDriven()) {
            return false;
        }
        return SymbolStyleLayer.hasPaintOverride(this.layout, name);
    }

    static hasPaintOverride(layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>, propertyName: string): boolean {
        const textField = layout.get('text-field');
        const property = properties.paint.properties[propertyName];
        let hasOverrides = false;

        const checkSections = (sections) => {
            for (const section of sections) {
                if (property.overrides && property.overrides.hasOverride(section)) {
                    hasOverrides = true;
                    return;
                }
            }
        };

        if (textField.value.kind === 'constant' && textField.value.value instanceof Formatted) {
            checkSections(textField.value.value.sections);
        } else if (textField.value.kind === 'source') {

            const checkExpression = (expression: Expression) => {
                if (hasOverrides) return;

                if (expression instanceof Literal && typeOf(expression.value) === FormattedType) {
                    const formatted: Formatted = (expression.value as any);
                    checkSections(formatted.sections);
                } else if (expression instanceof FormatExpression) {
                    checkSections(expression.sections);
                } else {
                    expression.eachChild(checkExpression);
                }
            };

            const expr: ZoomConstantExpression<'source'> = (textField.value as any);
            if (expr._styleExpression) {
                checkExpression(expr._styleExpression.expression);
            }
        }

        return hasOverrides;
    }
}

export type OverlapMode = 'never' | 'always' | 'cooperative';

export function getOverlapMode(layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>, overlapProp: 'icon-overlap', allowOverlapProp: 'icon-allow-overlap'): OverlapMode;
export function getOverlapMode(layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>, overlapProp: 'text-overlap', allowOverlapProp: 'text-allow-overlap'): OverlapMode;
export function getOverlapMode(layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>, overlapProp: 'icon-overlap' | 'text-overlap', allowOverlapProp: 'icon-allow-overlap' | 'text-allow-overlap'): OverlapMode {
    let result: OverlapMode = 'never';
    const overlap = layout.get(overlapProp);

    if (overlap) {
        // if -overlap is set, use it
        result = overlap;
    } else if (layout.get(allowOverlapProp)) {
        // fall back to -allow-overlap, with false='never', true='always'
        result = 'always';
    }

    return result;
}

export default SymbolStyleLayer;
