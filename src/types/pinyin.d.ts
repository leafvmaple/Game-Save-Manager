declare module 'pinyin' {
    interface PinyinOptions {
      style?: number;        // 拼音风格
      heteronym?: boolean;   // 是否启用多音字模式
      segment?: boolean;     // 是否启用分词
    }
  
    interface PinyinFunction {
      (words: string, options?: PinyinOptions): string[][];
      STYLE_NORMAL: number;       // 普通风格，即不带声调
      STYLE_TONE: number;         // 声调风格，拼音声调在韵母的第一个字母上
      STYLE_TONE2: number;        // 声调风格 2，即拼音声调在各个拼音之后，用数字 1-4 表示声调
      STYLE_TO3NE: number;        // 声调风格 3，即拼音声调在各个拼音之后，用数字 1-4 表示声调
      STYLE_INITIALS: number;     // 声母风格，只返回各个拼音的声母部分
      STYLE_FIRST_LETTER: number; // 首字母风格，只返回拼音的首字母部分
    }
  
    const pinyin: PinyinFunction;
    
    export default pinyin;
  }