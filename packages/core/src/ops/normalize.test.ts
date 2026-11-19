import { describe, expect, it } from 'vitest';
import { normalizeText } from './normalize.js';

describe('normalizeText', () => {
  it('lowercases Latin script', () => {
    expect(normalizeText('GAS Smell In The KITCHEN')).toBe('gas smell in the kitchen');
  });

  it('strips Arabic diacritics (harakat) and tanween', () => {
    expect(normalizeText('رَائِحَة غَاز')).toBe('رايحه غاز');
    expect(normalizeText('حَرِيقٌ')).toBe('حريق');
  });

  it('strips the superscript alef (U+0670)', () => {
    expect(normalizeText('مَجْرَىٰ')).toBe('مجري');
  });

  it('strips tatweel', () => {
    expect(normalizeText('غـــاز')).toBe('غاز');
    expect(normalizeText('تـــسرب')).toBe('تسرب');
  });

  it('unifies alef variants to bare alef', () => {
    expect(normalizeText('أ إ آ ا')).toBe('ا ا ا ا');
    expect(normalizeText('أسلاك')).toBe('اسلاك');
  });

  it('unifies ta-marbuta to heh and alef-maqsura to yeh', () => {
    expect(normalizeText('ريحة')).toBe('ريحه');
    expect(normalizeText('مجارى')).toBe('مجاري');
  });

  it('unifies hamza carriers', () => {
    expect(normalizeText('رائحة')).toBe('رايحه');
    expect(normalizeText('مسؤول')).toBe('مسوول');
  });

  it('converts Arabic-Indic and extended Arabic-Indic digits to ASCII', () => {
    expect(normalizeText('الوحدة ٥٠٠')).toBe('الوحده 500');
    expect(normalizeText('الوحدة ۵۱۲')).toBe('الوحده 512');
    expect(normalizeText('رقم ١٢٣٤٥٦٧٨٩٠')).toBe('رقم 1234567890');
  });

  it('collapses whitespace runs and trims', () => {
    expect(normalizeText('  gas \n\n  leak\t في   المطبخ  ')).toBe('gas leak في المطبخ');
  });

  it('drops zero-width and bidi control characters', () => {
    expect(normalizeText('غا\u200Bز\u200F')).toBe('غاز');
  });

  it('is idempotent', () => {
    const once = normalizeText('رَائِحَة غَاز قويّة ٥');
    expect(normalizeText(once)).toBe(once);
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText('   \n\t ')).toBe('');
  });
});
