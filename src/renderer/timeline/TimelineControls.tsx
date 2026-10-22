import { CalendarDays, ChevronLeft, ChevronRight, RotateCcw, LocateFixed, Pause, Play } from 'lucide-react';
import { IconButton } from '../components/IconButton';
import { dateKey, moveDay } from '../lib/time';

type Props = {
  selectedDate: string;
  onDateChange: (date: string) => void;
  onRefresh: () => void;
  loading: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  onNow: () => void;
  mode: 'day' | 'month';
  onModeChange: (mode: 'day' | 'month') => void;
};

export function TimelineControls({ selectedDate, onDateChange, onRefresh, loading, playing, onTogglePlay, onNow, mode, onModeChange }: Props) {
  const today = dateKey();
  // Adapted from Screenpipe v2.2.243 timeline-controls.tsx L145-173 (MIT).
  // Commit: 1b3e4186ec5a624b95a581c7187c1d48284bea9a. Use Shanghai day keys.
  const jumpDay = (days: number) => {
    const next = moveDay(selectedDate, days);
    onDateChange(next > today ? today : next);
  };

  return (
    <div className="timeline-controls" aria-label="时间导航">
      <div className="date-controls">
        <IconButton label="前一天" onClick={() => jumpDay(-1)}><ChevronLeft size={17} /></IconButton>
        <label className="date-input">
          <CalendarDays size={16} aria-hidden="true" />
          <input
            aria-label="回看日期"
            type="date"
            value={selectedDate}
            max={today}
            onChange={(event) => {
              if (event.target.value) onDateChange(event.target.value > today ? today : event.target.value);
            }}
          />
        </label>
        <IconButton label="后一天" onClick={() => jumpDay(1)} disabled={selectedDate >= today}><ChevronRight size={17} /></IconButton>
        <button className="text-button" type="button" disabled={selectedDate === today} onClick={() => onDateChange(today)}>今天</button>
      </div>
      <div className="control-actions">
        <div className="segmented-control" aria-label="时间视图">
          <button type="button" aria-pressed={mode === 'day'} onClick={() => onModeChange('day')}>日</button>
          <button type="button" aria-pressed={mode === 'month'} onClick={() => onModeChange('month')}>月</button>
        </div>
        <IconButton label="回到最新记录" onClick={onNow}><LocateFixed size={16} /></IconButton>
        <IconButton label={playing ? '暂停播放' : '播放'} onClick={onTogglePlay} disabled={mode === 'month'}>{playing ? <Pause size={16} /> : <Play size={16} />}</IconButton>
        <span className="timezone-label">上海时间</span>
        <IconButton label="刷新记录" onClick={onRefresh} disabled={loading}><RotateCcw size={16} className={loading ? 'is-spinning' : ''} /></IconButton>
      </div>
    </div>
  );
}
