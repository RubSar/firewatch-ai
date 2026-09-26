"""Transparent sizing estimates. GPU rates are hypothetical, never benchmarks."""
import json
import math
from pathlib import Path

ROOT=Path(__file__).resolve().parent

def calculate(a,n):
    if n <= 0 or not 0 < a['target_utilization'] < 1 or a['zones'] < 2:
        raise ValueError('Invalid capacity inputs')
    if not 0 < a['active_hours_per_day'] <= 24 or a['thermal_compression_ratio'] < 1:
        raise ValueError('Invalid recording assumptions')
    thermal_bps=a['thermal_width']*a['thermal_height']*a['thermal_bytes_per_pixel']*a['thermal_fps']/a['thermal_compression_ratio']
    rgb_bps=a['rgb_encoded_mbps']*1e6/8
    telemetry_bps=a['telemetry_hz']*a['telemetry_bytes']
    payload_bps=n*(thermal_bps+rgb_bps+telemetry_bps)
    archive_hour=n*(thermal_bps+rgb_bps+telemetry_bps)*3600
    meta_bps=n*a['rgb_fps']*a['metadata_events_per_rgb_frame']*a['mean_metadata_event_bytes']
    fire_rps=n*a['rgb_fps']*a['fire_requests_per_frame']
    vegetation_rps=n*a['vegetation_fps']
    fire=math.ceil(fire_rps/(a['hypothetical_fire_requests_per_gpu_second']*a['target_utilization']))
    vegetation=math.ceil(vegetation_rps/(a['hypothetical_vegetation_requests_per_gpu_second']*a['target_utilization']))
    # Equal pool distribution per zone; each surviving set of zones must sustain the load.
    fire_zone=math.ceil(fire_rps/(a['hypothetical_fire_requests_per_gpu_second']*a['target_utilization']*(a['zones']-1)))
    vegetation_zone=math.ceil(vegetation_rps/(a['hypothetical_vegetation_requests_per_gpu_second']*a['target_utilization']*(a['zones']-1)))
    return {'drones':n,'rgb_frames_per_second':n*a['rgb_fps'],
      'thermal_frames_per_second':n*a['thermal_fps'],'thermal_payload_mbps_per_drone':thermal_bps*8/1e6,
      'ingress_gbps_with_overhead':payload_bps*8/1e9*(1+a['network_overhead_fraction']),
      'original_data_tb_per_active_hour':archive_hour/1e12,
      'original_data_tb_per_day':archive_hour*a['active_hours_per_day']/1e12,
      'original_data_tb_for_retention':archive_hour*a['active_hours_per_day']*a['raw_retention_days']/1e12,
      'metadata_events_per_second':n*a['rgb_fps']*a['metadata_events_per_rgb_frame'],
      'metadata_ingest_mb_per_second':meta_bps/1e6,
      'kafka_metadata_tb_replicated_retention':meta_bps*3600*a['active_hours_per_day']*a['kafka_retention_days']*a['kafka_replication_factor']/1e12,
      'decoded_rgb_transfer_gbps_one_copy':n*a['rgb_width']*a['rgb_height']*a['rgb_channels']*a['rgb_fps']*8/1e9,
      'fire_inference_requests_per_second':fire_rps,'vegetation_inference_requests_per_second':vegetation_rps,
      'hypothetical_gpus_without_zone_failure_reserve':fire+vegetation,
      'hypothetical_fire_gpus_per_zone_with_failure_reserve':fire_zone,
      'hypothetical_vegetation_gpus_per_zone_with_failure_reserve':vegetation_zone,
      'hypothetical_gpus_with_one_zone_failure_reserve':(fire_zone+vegetation_zone)*a['zones']}

def main():
    a=json.loads((ROOT/'capacity-assumptions.json').read_text())
    results={'status':'planning_only_no_hardware_benchmark',
      'units':'decimal MB/GB/TB; Mbps and Gbps are bits per second',
      'excluded':['Storage redundancy/erasure overhead, indexes, snapshots and backups',
                  'Object request overhead, metadata not included in per-frame approximation, masks and grid exports',
                  'Network retransmission beyond generic allowance and cross-zone replication traffic',
                  'GPU decoder/encoder allocation, model memory constraints and hardware heterogeneity',
                  'Ingress-node/zone survival capacity, not just inference capacity'],
      'scenarios':[calculate(a,n) for n in a['scenarios_drones']]}
    (ROOT/'capacity-results.json').write_text(json.dumps(results,indent=2)+'\n')
    lines=['# Capacity scenarios','', 'All GPU values use hypothetical throughput assumptions, not measured hardware results. Original-data storage uses four active flight hours/day by default. Decimal units.','',
           '| Drones | RGB FPS | Thermal FPS | Ingress Gbps incl. allowance | Original TB/active hour | Original TB/7 days | Hypothetical GPUs incl. one-zone reserve |',
           '|---:|---:|---:|---:|---:|---:|---:|']
    for r in results['scenarios']:
        lines.append(f"| {r['drones']} | {r['rgb_frames_per_second']} | {r['thermal_frames_per_second']} | {r['ingress_gbps_with_overhead']:.3f} | {r['original_data_tb_per_active_hour']:.3f} | {r['original_data_tb_for_retention']:.2f} | {r['hypothetical_gpus_with_one_zone_failure_reserve']} |")
    lines+=['','See capacity-assumptions.json for all rates and capacity-results.json for exclusions, metadata storage and decoded-tensor fabric load. Replace throughput assumptions with benchmark measurements before buying or reserving GPUs.']
    (ROOT/'capacity-table.md').write_text('\n'.join(lines)+'\n')
    print('\n'.join(lines))

if __name__=='__main__':main()
