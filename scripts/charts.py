#!/usr/bin/env python3
"""ServiceBoot benchmark charts (Person 3).

Reads the results JSON written by `serviceboot benchmark` and draws:
  startup_time.png       mean startup time per config and algorithm, min-max whiskers
  per_service_ready.png  mean readiness time of every service, one panel per config
  peak_memory.png        peak resident memory of all service process trees
  cpu.png                mean CPU% of all service process trees during startup
  context_switches_voluntary.png / _involuntary.png   Linux-only switch counts

Every number comes from the JSON. Nothing is hard-coded or invented: a metric the
JSON marks unavailable is drawn as "N/A", never as zero.

Usage:
  python3 -m pip install -r scripts/requirements.txt
  python3 scripts/charts.py results/results.json --out charts/
"""
import argparse
import json
import os
import sys

try:
    import matplotlib
    matplotlib.use("Agg")  # files only, no display needed
    import matplotlib.pyplot as plt
except ImportError:  # pragma: no cover
    sys.exit("error: matplotlib is not installed. Run: python3 -m pip install -r scripts/requirements.txt")

ALGORITHMS = ["sequential", "parallel", "adaptive"]
# Fixed categorical order (never cycled): one colour per algorithm, the same in
# every chart. Palette validated for colour-blind separation; bars also carry
# value labels so identity and values never depend on colour alone.
COLORS = {"sequential": "#2a78d6", "parallel": "#eb6834", "adaptive": "#1baf7a"}
TEXT = "#0b0b0b"
MUTED = "#52514e"
GRID = "#e4e3df"


class DataError(Exception):
    pass


def load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        raise DataError(f"{path} does not exist. Run: node bin/serviceboot.js benchmark")
    except json.JSONDecodeError as error:
        raise DataError(f"{path} is not valid JSON: {error}")
    if data.get("schemaVersion") != 1:
        raise DataError(f"unsupported schemaVersion {data.get('schemaVersion')!r} (expected 1)")
    for key in ("summary", "configs", "runs", "environment", "settings"):
        if key not in data:
            raise DataError(f"results file is missing '{key}'")
    if not data["summary"]:
        raise DataError("results file has an empty summary")
    if not any(row.get("startupMs") for row in data["summary"]):
        raise DataError("no successful runs in this results file; nothing to chart")
    return data


def short(config):
    return os.path.splitext(os.path.basename(config))[0]


def style(ax, ylabel):
    ax.set_ylabel(ylabel, color=MUTED)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=MUTED)


def provenance(fig, data):
    env = data["environment"]
    settings = data["settings"]
    text = (f"Source: {data.get('_path')} · {data['startedAt']} · {env['platform']} {env['osRelease']} · "
            f"{env['logicalCpus']} logical CPUs · Node {env['node']} · {settings['runsPerPair']} runs per pair · "
            f"order: {settings['order']}")
    fig.text(0.01, 0.005, text, fontsize=7, color=MUTED, ha="left", va="bottom")


def rows_by(data):
    table = {}
    for row in data["summary"]:
        table[(row["config"], row["algorithm"])] = row
    configs = [c["path"] for c in data["configs"]]
    algorithms = [a for a in ALGORITHMS if a in data["settings"]["algorithms"]]
    return table, configs, algorithms


def grouped_bars(data, title, ylabel, value_of, fmt, filename, out, spread=True, note=None):
    table, configs, algorithms = rows_by(data)
    fig, ax = plt.subplots(figsize=(10, 5.6))
    width = 0.8 / len(algorithms)
    top = 0
    for a_index, algorithm in enumerate(algorithms):
        for c_index, config in enumerate(configs):
            row = table.get((config, algorithm))
            stats = value_of(row) if row else None
            x = c_index + (a_index - (len(algorithms) - 1) / 2) * width
            if not stats:
                ax.text(x, 0, "N/A", ha="center", va="bottom", fontsize=8, color=MUTED, rotation=90)
                continue
            mean = stats["mean"]
            ax.bar(x, mean, width * 0.92, color=COLORS[algorithm],
                   label=algorithm if c_index == 0 else None, zorder=2)
            label_y = mean
            if spread and stats.get("n", 1) > 1:
                ax.errorbar(x, mean, yerr=[[mean - stats["min"]], [stats["max"] - mean]],
                            fmt="none", ecolor=TEXT, elinewidth=1, capsize=3, zorder=3)
                label_y = stats["max"]
            text = fmt(mean)
            if algorithm == "adaptive" and row.get("effectiveAlgorithms"):
                text += "\n→ " + "/".join(row["effectiveAlgorithms"])
            ax.text(x, label_y, text, ha="center", va="bottom", fontsize=8, color=TEXT)
            top = max(top, label_y)
    ns = sorted({(value_of(r) or {}).get("n") for r in data["summary"] if value_of(r)})
    ax.set_xticks(range(len(configs)))
    ax.set_xticklabels([f"{short(c)}\n({next(x['services'] for x in data['configs'] if x['path'] == c)} services)" for c in configs])
    ax.set_ylim(0, top * 1.22 if top else 1)
    style(ax, ylabel)
    ax.set_title(f"{title}  (n = {', '.join(map(str, ns))} successful runs per bar)", color=TEXT, loc="left")
    ax.legend(frameon=False, ncol=len(algorithms), loc="upper left")
    if note:
        fig.text(0.01, 0.035, note, fontsize=8, color=MUTED, ha="left")
    provenance(fig, data)
    fig.tight_layout(rect=(0, 0.06, 1, 1))
    path = os.path.join(out, filename)
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def per_service(data, out):
    table, configs, algorithms = rows_by(data)
    fig, axes = plt.subplots(1, len(configs), figsize=(5 * len(configs), 5.2), squeeze=False)
    for ax, config in zip(axes[0], configs):
        names = []
        for algorithm in algorithms:
            row = table.get((config, algorithm))
            if row and row["perServiceReadyMs"]:
                names = list(row["perServiceReadyMs"].keys())
                break
        height = 0.8 / len(algorithms)
        for a_index, algorithm in enumerate(algorithms):
            row = table.get((config, algorithm))
            for s_index, name in enumerate(names):
                stats = (row or {}).get("perServiceReadyMs", {}).get(name)
                y = s_index + (a_index - (len(algorithms) - 1) / 2) * height
                if not stats:
                    ax.text(0, y, " N/A", va="center", fontsize=7, color=MUTED)
                    continue
                ax.barh(y, stats["mean"], height * 0.9, color=COLORS[algorithm],
                        label=algorithm if s_index == 0 else None, zorder=2)
                ax.text(stats["mean"], y, f" {stats['mean']:.0f}", va="center", fontsize=6.5, color=TEXT)
        ax.set_yticks(range(len(names)))
        ax.set_yticklabels(names)
        ax.invert_yaxis()
        ax.grid(axis="x", color=GRID, linewidth=0.8)
        ax.set_axisbelow(True)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.set_xlabel("ms from spawn to ready (mean)", color=MUTED)
        ax.set_title(short(config), color=TEXT, loc="left")
        ax.set_xlim(0, ax.get_xlim()[1] * 1.15)
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, frameon=False, ncol=len(labels), loc="upper right", fontsize=9)
    fig.suptitle("Per-service readiness time: measured from each service's own spawn", color=TEXT, x=0.01, ha="left")
    provenance(fig, data)
    fig.tight_layout(rect=(0, 0.04, 1, 0.95))
    path = os.path.join(out, "per_service_ready.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description="Draw ServiceBoot benchmark charts from results JSON.")
    parser.add_argument("results", nargs="?", default="results/results.json")
    parser.add_argument("--out", default="charts")
    args = parser.parse_args(argv)
    try:
        data = load(args.results)
    except DataError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    data["_path"] = args.results
    os.makedirs(args.out, exist_ok=True)
    written = []
    written.append(grouped_bars(
        data, "Startup time until every service is ready", "milliseconds (lower is better)",
        lambda r: r.get("startupMs"), lambda v: f"{v:,.0f}", "startup_time.png", args.out,
        note="Bars: mean. Whiskers: min–max of repeated runs. Adaptive is labelled with the algorithm it chose."))
    written.append(per_service(data, args.out))
    mb = lambda v: f"{v / 1048576:,.0f} MB"
    written.append(grouped_bars(
        data, "Peak resident memory of all service process trees", "bytes (peak RSS sum)",
        lambda r: r.get("peakRssBytes"), mb, "peak_memory.png", args.out,
        note="RSS summed over every process in every service tree; shared pages are counted per process (upper bound)."))
    written.append(grouped_bars(
        data, "Mean CPU of all service process trees during startup", "percent of one core",
        lambda r: r.get("meanCpuPercent"), lambda v: f"{v:.1f}%", "cpu.png", args.out,
        note=f"Sampled every {data['settings'].get('sampleIntervalMs')} ms; 100% = one fully busy core."))
    if any(r.get("voluntaryContextSwitches") for r in data["summary"]):
        written.append(grouped_bars(
            data, "Voluntary context switches of service processes", "count (mean per run)",
            lambda r: r.get("voluntaryContextSwitches"), lambda v: f"{v:,.0f}", "context_switches_voluntary.png", args.out,
            note="Linux /proc counters: a voluntary switch means the process blocked (sleep, I/O) and gave up the CPU."))
        written.append(grouped_bars(
            data, "Involuntary context switches of service processes", "count (mean per run)",
            lambda r: r.get("involuntaryContextSwitches"), lambda v: f"{v:,.0f}", "context_switches_involuntary.png", args.out,
            note="Linux /proc counters: an involuntary switch means the scheduler preempted a runnable process (more processes than cores)."))
    else:
        print("context switches: not available in this results file (only collected on Linux); chart skipped")
    for path in written:
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
