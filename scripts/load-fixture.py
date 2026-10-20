import argparse
import io
import json
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


def prepare(source, destination, users, layout):
    namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    word = lambda name: f'{{{namespace}}}{name}'
    with ZipFile(source) as archive:
        xml = archive.read('word/document.xml')
        declarations = []
        for _, declaration in ET.iterparse(io.BytesIO(xml), events=['start-ns']):
            prefix, uri = declaration
            declarations.append((prefix, uri))
            if not prefix.startswith('ns'):
                ET.register_namespace(prefix, uri)
        root = ET.fromstring(xml)
        body = root.find(word('body'))
        if body is None:
            raise ValueError('DOCX has no document body')
        section = body.find(word('sectPr'))
        targets = [f'[[U{index:02d}]] [[/U{index:02d}]]' for index in range(1, users + 1)]
        paragraphs = ['  '.join(targets)] if layout == 'clustered' else targets
        front_layout = layout in ('first-page', 'first-two-pages')
        first_page_users = (users + 1) // 2
        additions = []
        for index, text in enumerate(paragraphs):
            paragraph = ET.Element(word('p'))
            properties = ET.SubElement(paragraph, word('pPr'))
            if (not front_layout and (index == 0 or layout == 'separate-pages')) or (layout == 'first-two-pages' and index == first_page_users):
                ET.SubElement(properties, word('pageBreakBefore'))
            if front_layout:
                ET.SubElement(properties, word('spacing'), {word('before'): '0', word('after'): '0'})
            run = ET.SubElement(paragraph, word('r'))
            content = ET.SubElement(run, word('t'), {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'})
            content.text = text
            additions.append(ET.tostring(paragraph, encoding='utf-8'))
        prefix = next(prefix for prefix, uri in declarations if uri == namespace)
        qualified = lambda name: f'{prefix}:{name}' if prefix else name
        if front_layout:
            opening = re.search(rb'<' + re.escape(qualified('body').encode()) + rb'\b[^>]*>', xml)
            boundary = opening.end() if opening else -1
        else:
            boundary = xml.rfind(f'<{qualified("sectPr")}'.encode()) if section is not None else xml.rfind(f'</{qualified("body")}>'.encode())
        if boundary < 0:
            raise ValueError('Cannot locate the final document section boundary')
        prepared_xml = xml[:boundary] + b''.join(additions) + xml[boundary:]
        ET.fromstring(prepared_xml)
        Path(destination).parent.mkdir(parents=True, exist_ok=True)
        with ZipFile(destination, 'w') as output:
            for entry in archive.infolist():
                output.writestr(entry, prepared_xml if entry.filename == 'word/document.xml' else archive.read(entry.filename))
    placement = 'inserted on pages 1–2' if layout == 'first-two-pages' else 'inserted on page 1' if layout == 'first-page' else 'appended'
    return {'source': str(Path(source).resolve()), 'fixture': str(Path(destination).resolve()), 'layout': layout, 'targetParagraphs': len(paragraphs), 'targetPlacement': placement, 'appendedParagraphs': 0 if front_layout else len(paragraphs), 'users': users}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Insert synthetic typing targets in a copy of a DOCX.')
    parser.add_argument('source')
    parser.add_argument('destination')
    parser.add_argument('--users', type=int, required=True)
    parser.add_argument('--layout', choices=['separate-pages', 'different-paragraphs', 'clustered', 'first-page', 'first-two-pages'], required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.destination, args.users, args.layout)))
