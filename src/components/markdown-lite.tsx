import type { ReactNode } from "react";

"use client";

// Renderizador leve para o markdown gerado pela IA (títulos, listas, negrito).
// Mantém o HTML sob controle sem depender de bibliotecas externas.

function renderBold(text: string, keyPrefix: string) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={`${keyPrefix}-b${index}`} className="font-bold text-slate-900">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

export function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: ReactNode[] = [];
  let listBuffer: string[] = [];
  let key = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    elements.push(
      <ul key={`ul-${key++}`} className="mb-4 ml-5 list-disc space-y-1.5">
        {items.map((item, index) => (
          <li key={index} className="text-sm leading-6 text-slate-700">
            {renderBold(item, `li-${key}-${index}`)}
          </li>
        ))}
      </ul>,
    );
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith("- ") || line.startsWith("* ") || /^\d+\.\s/.test(line)) {
      listBuffer.push(line.replace(/^[-*]\s|^\d+\.\s/, ""));
      continue;
    }
    flushList();

    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={`h4-${key++}`} className="mt-4 mb-1.5 text-sm font-bold text-sky-800">
          {line.slice(4)}
        </h4>,
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h3
          key={`h3-${key++}`}
          className="mt-5 mb-2 border-l-4 border-sky-500 pl-3 text-base font-bold text-slate-950"
        >
          {line.slice(3)}
        </h3>,
      );
    } else if (line.startsWith("# ")) {
      elements.push(
        <h3 key={`h2-${key++}`} className="mt-5 mb-2 text-base font-bold text-slate-950">
          {line.slice(2)}
        </h3>,
      );
    } else if (line.length > 0) {
      elements.push(
        <p key={`p-${key++}`} className="mb-3 text-sm leading-6 text-slate-700">
          {renderBold(line, `p-${key}`)}
        </p>,
      );
    }
  }
  flushList();

  return <div>{elements}</div>;
}
