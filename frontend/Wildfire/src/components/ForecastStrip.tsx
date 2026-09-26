import type { ForecastHour } from '@firewatch/sim/weather'
import { compassLabel } from '@firewatch/sim/weather'

interface Props {
  forecast: ForecastHour[]
  simHours: number
}

export function ForecastStrip({ forecast, simHours }: Props) {
  const now = Math.floor(simHours)
  return (
    <div className="forecast">
      {forecast.map((h) => (
        <div key={h.hour} className={`fc-hour${h.hour === now ? ' now' : ''}`} title={`${compassLabel(h.windDir)} wind`}>
          {h.clock}
          <b>{Math.round(h.temperature)}&deg;</b>
          <span className="w">{Math.round(h.windSpeed)}</span> km/h
          <b style={{ color: '#7fb2d8', fontSize: 10 }}>{Math.round(h.humidity)}% RH</b>
        </div>
      ))}
    </div>
  )
}
