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

function dateStrsToRange(dateFrom: string, dateTo: string): DateRange | undefined {
  if (!dateFrom || !dateTo) return undefined;
  return { from: dateStrToPickerDate(dateFrom), to: dateStrToPickerDate(dateTo) };
}

export function WorkbenchDateRangePicker({
  dateFrom,
  dateTo,
  onChange,
  className,
}: WorkbenchDateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draftRange, setDraftRange] = useState<DateRange | undefined>(undefined);
  const todayStr = useMemo(() => cstTodayDateStr(), []);
  const today = useMemo(() => dateStrToPickerDate(todayStr), [todayStr]);

  const committedRange = useMemo(
    () => dateStrsToRange(dateFrom, dateTo),
    [dateFrom, dateTo],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setDraftRange(committedRange);
    }
  };

  const handleDayClick = (day: Date) => {
    if (!draftRange?.from || draftRange.to) {
      setDraftRange({ from: day, to: undefined });
      return;
    }

    const clamped = clampWorkbenchDateRange(
      pickerDateToDateStr(draftRange.from),
      pickerDateToDateStr(day),
    );
    onChange(clamped.dateFrom, clamped.dateTo);
    setDraftRange({
      from: dateStrToPickerDate(clamped.dateFrom),
      to: dateStrToPickerDate(clamped.dateTo),
    });
    setOpen(false);
  };

  const calendarSelected = open ? draftRange : committedRange;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
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
          defaultMonth={calendarSelected?.from ?? today}
          selected={calendarSelected}
          onDayClick={handleDayClick}
          numberOfMonths={1}
          disabled={(date) => {
            const candStr = pickerDateToDateStr(date);
            if (candStr > todayStr) return true;
            if (draftRange?.from && !draftRange?.to) {
              const fromStr = pickerDateToDateStr(draftRange.from);
              return workbenchDaysBetweenDateStrs(fromStr, candStr) > WORKBENCH_LIST_MAX_DATE_RANGE_DAYS;
            }
            return false;
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
