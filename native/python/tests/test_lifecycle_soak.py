"""Repeated lifecycle stress; no physical devices or authorization calls."""
import threading,time
from collections import defaultdict
from types import SimpleNamespace as NS
from ringhi import storage,ports
from ringhi.batch import Batch,Config


def pair(hub,node):
    return [ports.Port(f'COM{node+10}', 'USB\\VID_303A&PID_1001',hub+'E',hub,node,0),
            ports.Port(f'COM{node+20}', 'USB\\VID_3563&PID_2000',hub+'M',hub,node,4)]


def until(predicate):
    end=time.monotonic()+5
    while not predicate():
        assert time.monotonic()<end,'Lifecycle worker stalled'
        time.sleep(.005)


def test_twenty_batches_release_workers_and_keep_csv_after_mixed_outcomes(tmp_path,monkeypatch):
    monkeypatch.setattr(storage,'ROOT',tmp_path/'data')
    baseline={id(t) for t in threading.enumerate()}
    for generation in range(20):
        def execute(board,resolve):
            if generation%2 and board.hub=='B':raise OSError('controlled transport failure')
            board.update(espProgress=100)
        cfg=Config(tmp_path/'esp',tmp_path/'ml',tmp_path/'backups',mode='esp',production=False,limit=4)
        batch=Batch(cfg,NS(project=188),None,tmp_path/f'{generation}.csv',execute=execute)
        try:
            batch.observe([p for h in 'ABCD' for p in pair(h,generation)],set('ABCD'))
            until(lambda:len(batch.rows)==4 and not batch.busy)
        finally:batch.close()
        rows=batch.snapshots()
        assert len(rows)==4 and all(r['endedAt'] for r in rows)
        assert sum(r['result']=='失败' for r in rows)==generation%2
        assert batch.csv.read_bytes()==storage.csv_bytes(rows)
        assert all(not lock.locked() for lock in batch.leases.values())
        assert not [t for t in threading.enumerate() if id(t) not in baseline and t.name.startswith('RingHi-board')]


def test_twenty_four_board_reinsertions_never_overlap_or_hold_queue(tmp_path,monkeypatch):
    monkeypatch.setattr(storage,'ROOT',tmp_path/'data')
    active=defaultdict(int);entered=set();overlap=[];guard=threading.Lock();finish=threading.Event()
    def execute(board,resolve):
        with guard:
            active[board.hub]+=1;entered.add(board.id)
            if active[board.hub]>1:overlap.append(board.hub)
        try:
            while not finish.is_set():board.cancel.sleep(.005)
        finally:
            with guard:active[board.hub]-=1
    cfg=Config(tmp_path/'esp',tmp_path/'ml',tmp_path/'backups',mode='esp',production=False,limit=4)
    batch=Batch(cfg,NS(project=188),None,tmp_path/'churn.csv',execute=execute)
    try:
        for generation in range(21):
            if generation:batch.observe([],set())
            batch.observe([p for h in 'ABCD' for p in pair(h,generation)],set('ABCD'))
            ids={b.id for b in batch.current.values()}
            until(lambda:ids<=entered)
        finish.set();until(lambda:not batch.busy)
    finally:
        finish.set();batch.close()
    rows=batch.snapshots()
    assert len(rows)==84 and all(r['endedAt'] for r in rows)
    assert sum(r['result']=='已中断' for r in rows)==80
    assert sum(r['result']=='成功' for r in rows)==4
    assert not overlap and not any(active.values())
    assert batch.csv.read_bytes()==storage.csv_bytes(rows)
    assert all(not lock.locked() for lock in batch.leases.values())
