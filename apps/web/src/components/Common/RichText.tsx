import React, { useMemo } from 'react';
import { renderRichText } from '../../utils/richText';

interface RichTextProps {
  text: string;
  className?: string;
}

/** Renders a description (HTML, Markdown or plain text) through the sanitizer; never injects raw source markup. */
export const RichText: React.FC<RichTextProps> = ({ text, className = '' }) => {
  const html = useMemo(() => renderRichText(text), [text]);
  return <div className={`rich-text ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
};
