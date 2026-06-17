import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cstTodayDateStr } from "@/lib/format-datetime";
import { cn } from "@/lib/utils";
import {
  WORKBENCH_LIST_MAX_DATE_RANGE_DAYS,
  clampWorkbenchDateRange,
  workbenchDateStrToAnchor,
  workbenchDaysBetweenDateStrs,
  workbenchListDateRangeLabel,
} from "@/lib/workbench-email-list";

type WorkbenchDateRangePickerProps = {
  dateFrom: string;
  dateTo: string;
  onChange: (dateFrom: string, dateTo: string) => void;
  className?: string;
};

function dateStrToPickerDate(dateStr: string): Date {
  return workbenchDateStrToAnchor(dateStr);
}

function pickerDateToDateStr(d: Date): string {
  return cstTodayDateStr(d);
}

export function WorkbenchDateRangePicker({
  dateFrom,
  dateTo,
  onChange,
  className,
}: WorkbenchDateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const today = useMemo(() => dateStrToPickerDate(cstTodayDateStr()), []);

  const selected: DateRange | undefined =
    dateFrom && dateTo
      ? { from: dateStrToPickerDate(dateFrom), to: dateStrToPickerDate(dateTo) }
      : undefined;

  const handleSelect = (range: DateRange | undefined) => {
    if (!range?.from) return;
    const end = range.to ?? range.from;
    const clamped = clampWorkbenchDateRange(
      pickerDateToDateStr(range.from),
      pickerDateToDateStr(end),
    );
    onChange(clamped.dateFrom, clamped.dateTo);
    if (range.to) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-8 w-full justify-start text-xs font-normal px-2",
            className,
          )}
        >
          <CalendarIcon className="mr-1.5 h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="truncate">{workbenchListDateRangeLabel(dateFrom, dateTo)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          defaultMonth={selected?.from ?? today}
          selected={selected}
          onSelect={handleSelect}
          numberOfMonths={1}
          disabled={(date) => {
            if (date > today) return true;
            if (selected?.from && !selected?.to) {
              const fromStr = pickerDateToDateStr(selected.from);
              const candStr = pickerDateToDateStr(date);
              return workbenchDaysBetweenDateStrs(fromStr, candStr) > WORKBENCH_LIST_MAX_DATE_RANGE_DAYS;
            }
            return false;
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
