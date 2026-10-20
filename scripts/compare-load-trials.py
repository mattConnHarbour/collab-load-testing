import argparse
import colorsys
import csv
import html
import json
import math
import os
import statistics
from pathlib import Path
from xml.etree import ElementTree as ET

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

PALETTE = ['#1355ff', '#9333ea', '#00853d', '#cb0e47', '#b45309', '#0891b2', '#4f46e5', '#be185d', '#4d7c0f', '#a16207']


def mean(values):
    observed = [value for value in values if isinstance(value, (int, float)) and math.isfinite(value)]
    return statistics.mean(observed) if observed else None


def color(css):
    if not css.startswith('hsl('):
        return css
    hue, saturation, lightness = css[4:-1].split()
    return colorsys.hls_to_rgb(float(hue) / 360, float(lightness[:-1]) / 100, float(saturation[:-1]) / 100)


def fmt(value):
    return 'unobserved' if value is None else f'{value:,.1f}'


def main():
    parser = argparse.ArgumentParser(description='Compare per-user mean latencies from completed load-test reports.')
    parser.add_argument('reports', nargs='+', type=Path, help='Trial directories containing results.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--failed-attempt', action='append', type=Path, default=[], help='Retained earlier attempt to disclose separately')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    trials = []
    for directory in args.reports:
        report = json.loads((directory / 'results.json').read_text())
        users = []
        for user in report['users']:
            users.append({
                'id': user['id'], 'color': user['color'],
                'localMeanMs': mean([key['localMs'] for key in user['keystrokes']]),
                'remoteMeanMs': mean([key['remoteMs'] for key in user['keystrokes']]),
                'localObserved': user['local']['count'], 'remoteObserved': user['remote']['count'],
                'expectedKeys': len(report['expectedText']), 'matches': user['matches'],
                'achievedCharsPerSecond': user['achievedCharsPerSecond'],
                'inputDeliveryMeanMs': mean([key['inputDeliveryMs'] for key in user['keystrokes']]),
                'pages': sorted({image['page'] for image in report['images'] if any(h['user'] == user['id'] for h in image['highlights'])}),
            })
        if not users:
            for index in range(report['config']['users']):
                users.append({
                    'id': f'U{index + 1:02d}',
                    'color': PALETTE[index] if index < len(PALETTE) else f'hsl({index * 137.5 % 360} 65% 40%)',
                    'localMeanMs': None, 'remoteMeanMs': None, 'localObserved': None, 'remoteObserved': None,
                    'expectedKeys': len(report['expectedText']), 'matches': None,
                    'achievedCharsPerSecond': None, 'inputDeliveryMeanMs': None, 'pages': [],
                })
        users.sort(key=lambda user: (user['localMeanMs'] is None, user['localMeanMs'] or 0))
        trials.append({
            'writers': report['config']['users'], 'status': report['status'], 'users': users,
            'localMeanMs': mean([key['localMs'] for user in report['users'] for key in user['keystrokes']]),
            'remoteMeanMs': mean([key['remoteMs'] for user in report['users'] for key in user['keystrokes']]),
            'peakTyping': max((frame['typing'] for frame in report['timeline']), default=None),
            'peakConnected': max((frame['connectedBrowsers'] for frame in report['timeline']), default=None),
            'clockUncertaintyMs': report['clockUncertaintyMs'], 'failures': report['failures'],
            'topology': report.get('topology'), 'config': report['config'],
            'reportPath': str(directory.resolve()),
        })
    trials.sort(key=lambda trial: trial['writers'])
    all_users = {user['id']: user['color'] for trial in trials for user in trial['users']}
    (args.output / 'comparison.json').write_text(json.dumps(trials, indent=2))
    with (args.output / 'users.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['writers', 'user', 'local_mean_ms', 'remote_mean_ms', 'local_observed', 'remote_observed', 'expected_keys', 'achieved_chars_per_second', 'input_delivery_mean_ms', 'final_text_matches', 'final_pages'])
        for trial in trials:
            for user in trial['users']:
                writer.writerow([trial['writers'], user['id'], user['localMeanMs'], user['remoteMeanMs'], user['localObserved'], user['remoteObserved'], user['expectedKeys'], user['achievedCharsPerSecond'], user['inputDeliveryMeanMs'], user['matches'], ','.join(map(str, user['pages']))])

    svg_charts = []
    for metric, name, label in [('localMeanMs', 'typing-latency', 'Mean local typing latency per user (ms)'), ('remoteMeanMs', 'observer-latency', 'Mean observer arrival latency per user (ms)')]:
        fig, ax = plt.subplots(figsize=(13, 9))
        fig.subplots_adjust(left=0.11, right=0.97, top=0.90, bottom=0.25)
        ax.set_facecolor('#f8fafc')
        tips = {}
        for trial in trials:
            if not any(user[metric] is not None for user in trial['users']):
                ax.text(trial['writers'], 0.04, 'Timed out\nno latency traces', transform=ax.get_xaxis_transform(), ha='center', color='#b91c1c', fontsize=11)
            for user in sorted(trial['users'], key=lambda user: user[metric] or 0):
                if user[metric] is None:
                    continue
                gid = f"{name}-point-{trial['writers']}-{user['id']}"
                point = ax.scatter(trial['writers'], user[metric], s=80, c=[color(user['color'])], edgecolors='white', linewidths=0.7, zorder=3)
                point.set_gid(gid)
                tips[gid] = f"{trial['writers']} writers · {user['id']} · {user[metric]:.1f} ms · local {fmt(user['localMeanMs'])} ms · observer {fmt(user['remoteMeanMs'])} ms"
        ax.set_xticks([trial['writers'] for trial in trials])
        counts = [trial['writers'] for trial in trials]
        ax.set_xlim(min(counts) - 4, max(counts) + 4)
        ax.set_ylim(bottom=0)
        ax.set_xlabel('Number of simultaneously scheduled typing users', fontsize=13)
        ax.set_ylabel(label, fontsize=13)
        ax.set_title('First-page collaboration load: one colored dot per user', fontsize=16, loc='left', pad=20)
        ax.grid(axis='y', color='#dce2eb', linewidth=0.7)
        ax.spines[['top', 'right']].set_visible(False)
        handles = [Line2D([], [], marker='o', linestyle='', color=color(css), label=uid, markersize=7) for uid, css in sorted(all_users.items())]
        fig.legend(handles=handles, loc='lower center', ncols=10, frameon=False, fontsize=10, title='Synthetic user slot (same color across trials)', bbox_to_anchor=(0.5, 0.015))
        fig.savefig(args.output / f'{name}.png', dpi=180)
        fig.savefig(args.output / f'{name}.svg')
        plt.close(fig)
        svg_file = args.output / f'{name}.svg'
        tree = ET.parse(svg_file)
        ns = 'http://www.w3.org/2000/svg'
        ET.register_namespace('', ns)
        for element in tree.iter():
            gid = element.attrib.get('id', '')
            if gid in tips:
                ET.SubElement(element, f'{{{ns}}}title').text = tips[gid]
                element.set('data-user', gid.rsplit('-', 1)[-1])
                element.set('class', 'user-point')
        tree.write(svg_file, encoding='unicode')
        svg_charts.append(svg_file.read_text())

    esc = html.escape
    legend = ''.join(f'<button data-user="{esc(uid)}"><i style="background:{esc(css)}"></i>{esc(uid)}</button>' for uid, css in sorted(all_users.items()))
    summaries = ''
    details = ''
    attempt_notes = ''
    for directory in args.failed_attempt:
        attempt = json.loads((directory / 'results.json').read_text())
        link = os.path.relpath(directory / 'report.html', args.output)
        reasons = '<br>'.join(esc(reason.split('\n')[0]) for reason in attempt['failures'])
        attempt_notes += f'<p class="note">Retained earlier attempt: <a href="{esc(link)}">{attempt["config"]["users"]} writers</a>, status {esc(attempt["status"])}. {reasons}. No per-user means were available from this attempt, so it contributes no dots. Retry uses a longer timeout with the same typing workload.</p>'
    for trial in trials:
        count = trial['writers']
        rates = [u['achievedCharsPerSecond'] for u in trial['users'] if u['achievedCharsPerSecond'] is not None]
        rate = f'{min(rates):.2f}–{max(rates):.2f}' if rates else '—'
        relative = Path(os.path.relpath(trial['reportPath'], args.output))
        link = str(relative / 'report.html')
        summaries += f'<tr><td><a href="{esc(link)}">{count}</a></td><td>{esc(trial["status"])}</td><td>{fmt(trial["localMeanMs"])}</td><td>{fmt(trial["remoteMeanMs"])}</td><td>{trial["peakTyping"] if trial["peakTyping"] is not None else "unavailable"}</td><td>{trial["peakConnected"] if trial["peakConnected"] is not None else "unavailable"}</td><td>{rate}</td><td>±{trial["clockUncertaintyMs"]:.2f}</td></tr>'
        rows = ''.join(f'<tr><td><i style="background:{esc(u["color"])}"></i>{u["id"]}</td><td>{fmt(u["localMeanMs"])}</td><td>{fmt(u["remoteMeanMs"])}</td><td>{u["localObserved"] if u["localObserved"] is not None else "unknown"}/{u["expectedKeys"]}</td><td>{u["remoteObserved"] if u["remoteObserved"] is not None else "unknown"}/{u["expectedKeys"]}</td><td>{fmt(u["inputDeliveryMeanMs"])}</td><td>{esc(str(u["pages"])) if u["pages"] else "unavailable"}</td><td>{u["matches"] if u["matches"] is not None else "unavailable"}</td></tr>' for u in trial['users'])
        failures = '<br>'.join(esc(failure) for failure in trial['failures']) or 'All expected text converged.'
        details += f'<h2>{count} writers</h2><p>{failures}</p><p><a href="{esc(link)}">Full trial report and annotated document images</a></p><table><thead><tr><th>User</th><th>Mean local ms</th><th>Mean observer ms</th><th>Local keys</th><th>Observer keys</th><th>Mean input delivery ms</th><th>Final pages</th><th>Text matched</th></tr></thead><tbody>{rows}</tbody></table>'
    phrase = trials[0]['config']['text']
    markup = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>First-page typing load comparison</title>
<style>body{{font:15px system-ui;color:#172033;background:#f3f5f8;margin:0}}main{{max-width:1250px;margin:24px auto;background:white;padding:32px}}h1{{font-size:28px}}p{{line-height:1.6}}svg{{width:100%;height:auto}}table{{width:100%;border-collapse:collapse;margin:20px 0}}td,th{{text-align:left;padding:10px;border-bottom:1px solid #e2e8f0}}i{{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:7px}}button{{background:white;border:1px solid #ccd4df;padding:6px;margin:3px;cursor:pointer}}.legend{{margin:12px 0}}.user-point{{cursor:help}}.focused .user-point{{opacity:.15}}.focused .user-point.active{{opacity:1}}a{{color:#1355ff}}.note{{background:#eef3ff;padding:14px}}</style><main>
<h1>First-page typing load comparison</h1><p>10, 20, and 30 writers were scheduled together at 5 characters/second, with zero stagger, each typing <b>{esc(phrase)}</b> once in their own paragraph on page 1 of the NDA test copy. Each trial adds one passive observer. Trials ran sequentially; one selected run per size is shown. Failed runs without collected traces have no latency dots.</p>{attempt_notes}
<p class="note">Server, generator, and observer run in separate processes on this Mac; CPU and memory are shared. These results include local machine contention. Local latency measures actual browser keydown to the first DOM update containing the expected text prefix, rather than physical screen paint. Observer latency measures that keydown to prefix arrival in the observer DOM after clock calibration. Input delivery delay, before the browser keydown, is reported separately. Missing measurements are excluded from means and their observed counts are shown below. This is an exploratory comparison, not a repeated statistical benchmark.</p>
<table><thead><tr><th>Writers / report</th><th>Status</th><th>Mean local ms</th><th>Mean observer ms</th><th>Peak typing within 1 s</th><th>Peak connected incl. observer</th><th>Achieved chars/s</th><th>Clock uncertainty ms</th></tr></thead><tbody>{summaries}</tbody></table>
<h2>Average typing latency by user</h2><p>Dots sit at the exact writer count and measured mean; lower latency appears lower. Colors identify synthetic user slots consistently across trials, and close values can overlap. Hover a dot for its user and latency, or select a user in the key to highlight that user across both charts.</p><div class="legend">{legend}<button id="reset">Show all</button></div>{svg_charts[0]}<p><a href="typing-latency.png">PNG chart</a> · <a href="typing-latency.svg">SVG chart</a></p>
<h2>Observer arrival latency by user</h2>{svg_charts[1]}<p><a href="observer-latency.png">PNG chart</a> · <a href="users.csv">Per-user CSV</a> · <a href="comparison.json">Comparison JSON</a></p>
<p>Tables are ordered by mean local latency, lowest first.</p>{details}</main>
<script>document.querySelectorAll('.legend button[data-user]').forEach(button=>button.addEventListener('click',()=>{{document.body.classList.add('focused');document.querySelectorAll('.user-point').forEach(point=>point.classList.toggle('active',point.dataset.user===button.dataset.user));}}));document.querySelector('#reset').addEventListener('click',()=>document.body.classList.remove('focused'));</script></html>'''
    (args.output / 'report.html').write_text(markup)
    print(args.output / 'report.html')


if __name__ == '__main__':
    main()
