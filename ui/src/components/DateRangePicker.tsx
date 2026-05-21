import * as React from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface DateRangePickerProps {
  from: string
  to: string
  onChange: (range: { from: string; to: string }) => void
  className?: string
}

function parseDate(value: string): Date | undefined {
  if (!value) return undefined
  const d = new Date(value + "T00:00:00")
  return isNaN(d.getTime()) ? undefined : d
}

function formatDate(date: Date | undefined): string {
  if (!date || isNaN(date.getTime())) return ""
  return format(date, "yyyy-MM-dd")
}

export function DateRangePicker({ from, to, onChange, className }: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false)

  const fromDate = parseDate(from)
  const toDate = parseDate(to)

  const range: DateRange | undefined =
    fromDate && toDate
      ? { from: fromDate, to: toDate }
      : fromDate
        ? { from: fromDate, to: undefined }
        : undefined

  const handleSelect = (selectedRange: DateRange | undefined) => {
    const nextFrom = formatDate(selectedRange?.from)
    const nextTo = formatDate(selectedRange?.to)

    onChange({ from: nextFrom, to: nextTo })

    // Close popover when both dates are selected
    if (nextFrom && nextTo) {
      setOpen(false)
    }
  }

  const displayText = React.useMemo(() => {
    if (fromDate && toDate) {
      return `${format(fromDate, "MMM d, yyyy")} - ${format(toDate, "MMM d, yyyy")}`
    }
    if (fromDate) {
      return `${format(fromDate, "MMM d, yyyy")} - ...`
    }
    return "Pick a date range"
  }, [fromDate, toDate])

  return (
    <div className={cn("grid gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="date"
            variant={"outline"}
            className={cn(
              "w-full justify-start text-left font-normal sm:w-[300px]",
              !fromDate && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {displayText}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            initialFocus
            mode="range"
            defaultMonth={fromDate}
            selected={range}
            onSelect={handleSelect}
            numberOfMonths={1}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
